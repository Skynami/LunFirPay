/**
 * 通道选择器
 * 实现支付通道的智能选择逻辑
 */
const db = require('../config/database');

// 支付类型配置（内联）
const payTypes = [
  { id: 1, name: 'alipay', showname: '支付宝', icon: 'alipay.ico', device: 0, status: 1, sort: 1 },
  { id: 2, name: 'wxpay', showname: '微信支付', icon: 'wxpay.ico', device: 0, status: 1, sort: 2 },
  { id: 3, name: 'qqpay', showname: 'QQ钱包', icon: 'qqpay.ico', device: 0, status: 1, sort: 3 },
  { id: 4, name: 'bank', showname: '网银支付', icon: 'bank.ico', device: 0, status: 1, sort: 4 },
  { id: 5, name: 'jdpay', showname: '京东支付', icon: 'jdpay.ico', device: 0, status: 1, sort: 5 },
  { id: 6, name: 'paypal', showname: 'PayPal', icon: 'paypal.ico', device: 0, status: 1, sort: 6 },
  { id: 7, name: 'ecny', showname: '数字人民币', icon: 'ecny.ico', device: 0, status: 1, sort: 7 }
];

function getPayTypeByName(name, device = 'pc') {
  const deviceCode = device === 'mobile' ? 2 : 1;
  return payTypes.find(pt => pt.name === name && pt.status === 1 && (pt.device === 0 || pt.device === deviceCode)) || null;
}

function getPayTypeById(id) {
  return payTypes.find(pt => pt.id === id) || null;
}

function getAllPayTypes(device = null) {
  if (!device) return payTypes.filter(pt => pt.status === 1).sort((a, b) => a.sort - b.sort);
  const deviceCode = device === 'mobile' ? 2 : 1;
  return payTypes.filter(pt => pt.status === 1 && (pt.device === 0 || pt.device === deviceCode)).sort((a, b) => a.sort - b.sort);
}

// 通道选择模式
const CHANNEL_MODE = {
    DISABLED: 0,        // 关闭该支付方式
    RANDOM: -1,         // 随机可用通道
    SEQUENTIAL: -4,     // 顺序可用通道
    FIRST: -5,          // 首个可用通道
    GROUP: -3,          // 使用轮询组
    // 正数表示指定通道ID
};

/**
 * 获取通道今日已用额度
 * @param {number} channelId - 通道ID（数据库主键）
 * @returns {number} - 今日已用金额
 */
async function getChannelTodayUsed(channelId) {
    const [[result]] = await db.query(
        `SELECT COALESCE(SUM(money), 0) as used 
         FROM orders 
         WHERE channel_id = ? AND status = 1 AND DATE(created_at) = CURDATE()`,
        [channelId]
    );
    return parseFloat(result.used) || 0;
}

/**
 * 检查通道是否可用（单日限额检查）
 * @param {object} channel - 通道对象
 * @param {number} money - 订单金额
 * @returns {boolean} - 是否可用
 */
async function checkChannelDayLimit(channel, money) {
    const dayLimit = parseFloat(channel.day_limit) || 0;
    if (dayLimit === 0) return true; // 无限制
    
    const todayUsed = await getChannelTodayUsed(channel.id);
    return (todayUsed + money) <= dayLimit;
}

/**
 * 从通道列表中过滤出满足单日限额的通道
 * @param {array} channels - 通道列表
 * @param {number} money - 订单金额
 * @returns {array} - 过滤后的通道列表
 */
async function filterByDayLimit(channels, money) {
    const result = [];
    for (const channel of channels) {
        if (await checkChannelDayLimit(channel, money)) {
            result.push(channel);
        }
    }
    return result;
}

/**
 * 获取商户的支付组配置
 * @param {string} merchantId - 商户ID
 * @returns {object|null} - 支付组配置
 */
async function getMerchantPayGroup(merchantId) {
    // 1. 先查询商户是否有单独设置的支付组
    const [merchants] = await db.query(
        'SELECT pay_group_id FROM merchants WHERE user_id = ?',
        [merchantId]
    );
    
    let groupId = merchants[0]?.pay_group_id;
    
    // 2. 如果没有单独设置，使用默认组
    if (!groupId) {
        const [defaultGroups] = await db.query(
            'SELECT id FROM provider_pay_groups WHERE is_default = 1 LIMIT 1'
        );
        groupId = defaultGroups[0]?.id;
    }
    
    if (!groupId) return null;
    
    // 3. 获取支付组配置
    const [groups] = await db.query(
        'SELECT * FROM provider_pay_groups WHERE id = ?',
        [groupId]
    );
    
    if (groups.length === 0) return null;
    
    const group = groups[0];
    group.config = group.config ? JSON.parse(group.config) : {};
    return group;
}

/**
 * 获取支付方式信息
 * @param {string} typeName - 支付方式名称 alipay/wxpay/qqpay/bank
 * @param {string} device - 设备类型 pc/mobile
 * @returns {object|null}
 */
async function getPayType(typeName, device = 'pc') {
    return getPayTypeByName(typeName, device);
}

/**
 * 获取所有可用支付方式
 * @param {string} merchantId - 商户ID
 * @param {string} device - 设备类型
 * @returns {array}
 */
async function getAvailablePayTypes(merchantId, device = 'pc') {
    // 获取所有启用的支付方式（从配置文件）
    const payTypes = getAllPayTypes(device);
    
    // 获取商户的支付组配置
    const payGroup = await getMerchantPayGroup(merchantId);
    if (!payGroup) {
        // 没有配置支付组，返回所有有可用通道的支付方式
        const result = [];
        for (const pt of payTypes) {
            const hasChannel = await hasAvailableChannel(pt.id);
            if (hasChannel) {
                result.push(pt);
            }
        }
        return result;
    }
    
    // 根据支付组配置过滤
    const result = [];
    for (const pt of payTypes) {
        const typeConfig = payGroup.config[pt.id];
        
        // 检查是否禁用
        if (typeConfig && typeConfig.channel_mode === CHANNEL_MODE.DISABLED) {
            continue;
        }
        
        // 检查是否有可用通道
        const hasChannel = await hasAvailableChannel(pt.id, typeConfig);
        if (hasChannel) {
            // 添加自定义费率
            if (typeConfig && typeConfig.rate) {
                pt.rate = typeConfig.rate;
            }
            result.push(pt);
        }
    }
    
    return result;
}

/**
 * 检查是否有可用通道
 */
async function hasAvailableChannel(payTypeId, typeConfig = null) {
    if (typeConfig && typeConfig.channel_mode > 0) {
        // 指定了具体通道
        const [channels] = await db.query(
            'SELECT id FROM provider_channels WHERE id = ? AND status = 1 AND (is_deleted = 0 OR is_deleted IS NULL) LIMIT 1',
            [typeConfig.channel_mode]
        );
        return channels.length > 0;
    }
    
    if (typeConfig && typeConfig.channel_mode === CHANNEL_MODE.GROUP && typeConfig.group_id) {
        // 使用轮询组
        const [groups] = await db.query(
            'SELECT id FROM channel_groups WHERE id = ? AND status = 1 LIMIT 1',
            [typeConfig.group_id]
        );
        return groups.length > 0;
    }
    
    // 随机/顺序/首个可用 - 检查是否有该类型的可用通道（支持多类型）
    const payType = getPayTypeById(payTypeId);
    if (!payType) return false;
    
    const [channels] = await db.query(
        `SELECT id FROM provider_channels 
         WHERE status = 1 AND (is_deleted = 0 OR is_deleted IS NULL)
         AND FIND_IN_SET(?, pay_type) > 0
         LIMIT 1`,
        [payType.name]
    );
    return channels.length > 0;
}

/**
 * 选择支付通道
 * @param {string} typeName - 支付方式名称
 * @param {string} merchantId - 商户ID
 * @param {number} money - 支付金额
 * @param {string} device - 设备类型
 * @returns {object|null} - 通道信息
 */
async function selectChannel(typeName, merchantId, money, device = 'pc') {
    // 1. 获取支付方式
    const payType = await getPayType(typeName, device);
    if (!payType) {
        return null;
    }
    
    // 2. 获取商户的支付组配置
    const payGroup = await getMerchantPayGroup(merchantId);
    const typeConfig = payGroup?.config?.[payType.id] || {};
    
    // 3. 检查是否禁用
    if (typeConfig.channel_mode === CHANNEL_MODE.DISABLED) {
        return null;
    }
    
    // 4. 根据配置选择通道
    let channel = null;
    const channelMode = typeConfig.channel_mode || CHANNEL_MODE.RANDOM;
    
    if (channelMode > 0) {
        // 指定具体通道
        channel = await getChannelById(channelMode, money);
    } else if (channelMode === CHANNEL_MODE.GROUP && typeConfig.group_id) {
        // 使用轮询组
        channel = await getChannelFromGroup(typeConfig.group_id, money);
    } else if (channelMode === CHANNEL_MODE.SEQUENTIAL) {
        // 顺序选择
        channel = await getChannelSequential(payType.name, money, payGroup?.id);
    } else if (channelMode === CHANNEL_MODE.FIRST) {
        // 首个可用
        channel = await getChannelFirst(payType.name, money);
    } else {
        // 默认随机选择
        channel = await getChannelRandom(payType.name, money);
    }
    
    if (!channel) {
        return null;
    }
    
    // 5. 计算费率
    const rate = typeConfig.rate || channel.fee_rate || 0;
    
    return {
        payTypeId: payType.id,
        payTypeName: payType.name,
        channelId: channel.id,
        pluginName: channel.plugin_name,
        rate: rate,
        channel: channel
    };
}

/**
 * 根据ID获取通道
 */
async function getChannelById(channelId, money) {
    const [channels] = await db.query(
        `SELECT * FROM provider_channels 
         WHERE id = ? AND status = 1 AND (is_deleted = 0 OR is_deleted IS NULL)
         AND (min_money = 0 OR min_money <= ?)
         AND (max_money = 0 OR max_money >= ?)
         LIMIT 1`,
        [channelId, money, money]
    );
    
    if (channels.length === 0) return null;
    
    // 检查单日限额
    if (await checkChannelDayLimit(channels[0], money)) {
        return channels[0];
    }
    return null;
}

/**
 * 随机选择通道
 */
async function getChannelRandom(payTypeName, money) {
    const [channels] = await db.query(
        `SELECT * FROM provider_channels 
         WHERE status = 1 AND (is_deleted = 0 OR is_deleted IS NULL)
         AND FIND_IN_SET(?, pay_type) > 0
         AND (min_money = 0 OR min_money <= ?)
         AND (max_money = 0 OR max_money >= ?)`,
        [payTypeName, money, money]
    );
    
    // 过滤单日限额
    const available = await filterByDayLimit(channels, money);
    if (available.length === 0) return null;
    
    // 随机选择一个
    const randomIndex = Math.floor(Math.random() * available.length);
    return available[randomIndex];
}

/**
 * 顺序选择通道
 */
async function getChannelSequential(payTypeName, money, groupId) {
    const [channels] = await db.query(
        `SELECT * FROM provider_channels 
         WHERE status = 1 AND (is_deleted = 0 OR is_deleted IS NULL)
         AND FIND_IN_SET(?, pay_type) > 0
         AND (min_money = 0 OR min_money <= ?)
         AND (max_money = 0 OR max_money >= ?)
         ORDER BY priority DESC, id ASC`,
        [payTypeName, money, money]
    );
    
    // 过滤单日限额
    const available = await filterByDayLimit(channels, money);
    if (available.length === 0) return null;
    
    // 获取当前索引
    let currentIndex = 0;
    if (groupId) {
        const [[group]] = await db.query(
            'SELECT config FROM provider_pay_groups WHERE id = ?',
            [groupId]
        );
        if (group) {
            const config = JSON.parse(group.config || '{}');
            currentIndex = config._sequential_index || 0;
        }
    }
    
    const index = currentIndex % available.length;
    const channel = available[index];
    
    // 更新索引
    if (groupId) {
        const [[group]] = await db.query(
            'SELECT config FROM provider_pay_groups WHERE id = ?',
            [groupId]
        );
        if (group) {
            const config = JSON.parse(group.config || '{}');
            config._sequential_index = (currentIndex + 1) % available.length;
            await db.query(
                'UPDATE provider_pay_groups SET config = ? WHERE id = ?',
                [JSON.stringify(config), groupId]
            );
        }
    }
    
    return channel;
}

/**
 * 首个可用通道
 */
async function getChannelFirst(payTypeName, money) {
    const [channels] = await db.query(
        `SELECT * FROM provider_channels 
         WHERE status = 1 AND (is_deleted = 0 OR is_deleted IS NULL)
         AND FIND_IN_SET(?, pay_type) > 0
         AND (min_money = 0 OR min_money <= ?)
         AND (max_money = 0 OR max_money >= ?)
         ORDER BY priority DESC, id ASC`,
        [payTypeName, money, money]
    );
    
    // 过滤单日限额，返回第一个可用的
    for (const channel of channels) {
        if (await checkChannelDayLimit(channel, money)) {
            return channel;
        }
    }
    return null;
}

/**
 * 从轮询组选择通道
 */
async function getChannelFromGroup(groupId, money) {
    const [groups] = await db.query(
        'SELECT * FROM channel_groups WHERE id = ? AND status = 1',
        [groupId]
    );
    
    if (groups.length === 0) return null;
    
    const group = groups[0];
    const channelsConfig = JSON.parse(group.channels || '[]');
    
    if (channelsConfig.length === 0) return null;
    
    // 获取所有配置的通道详情，并过滤金额限制
    const channelIds = channelsConfig.map(c => c.id);
    const [channels] = await db.query(
        `SELECT * FROM provider_channels 
         WHERE id IN (?) AND status = 1 AND (is_deleted = 0 OR is_deleted IS NULL)
         AND (min_money = 0 OR min_money <= ?)
         AND (max_money = 0 OR max_money >= ?)`,
        [channelIds, money, money]
    );
    
    if (channels.length === 0) return null;
    
    // 过滤单日限额
    const availableChannels = await filterByDayLimit(channels, money);
    if (availableChannels.length === 0) return null;
    
    // 创建ID到通道的映射
    const channelMap = {};
    availableChannels.forEach(c => channelMap[c.id] = c);
    
    // 过滤出可用的配置
    const availableConfigs = channelsConfig.filter(c => channelMap[c.id]);
    if (availableConfigs.length === 0) return null;
    
    let selectedConfig;
    
    if (group.mode === 1) {
        // 加权随机
        selectedConfig = weightedRandom(availableConfigs);
    } else if (group.mode === 2) {
        // 首个可用
        selectedConfig = availableConfigs[0];
    } else {
        // 顺序轮询
        const index = group.current_index % availableConfigs.length;
        selectedConfig = availableConfigs[index];
        
        // 更新索引
        await db.query(
            'UPDATE channel_groups SET current_index = ? WHERE id = ?',
            [(group.current_index + 1) % availableConfigs.length, groupId]
        );
    }
    
    return channelMap[selectedConfig.id];
}

/**
 * 加权随机选择
 */
function weightedRandom(items) {
    const totalWeight = items.reduce((sum, item) => sum + (item.weight || 1), 0);
    let random = Math.random() * totalWeight;
    
    for (const item of items) {
        random -= (item.weight || 1);
        if (random <= 0) {
            return item;
        }
    }
    
    return items[items.length - 1];
}

/**
 * 获取通道详情
 */
async function getChannelInfo(channelId) {
    const [channels] = await db.query(
        'SELECT * FROM provider_channels WHERE id = ?',
        [channelId]
    );
    
    if (channels.length === 0) return null;
    
    const channel = channels[0];
    channel.config = channel.config ? JSON.parse(channel.config) : {};
    return channel;
}

module.exports = {
    CHANNEL_MODE,
    getMerchantPayGroup,
    getPayType,
    getAvailablePayTypes,
    selectChannel,
    getChannelInfo,
    getChannelById,
    getChannelRandom,
    getChannelFromGroup
};
