/**
 * 支付组管理路由
 * 管理支付方式、通道轮询组、支付组配置
 */
const express = require('express');
const router = express.Router();
const db = require('../config/database');
const channelSelector = require('../utils/channelSelector');

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

function getAllPayTypes(device = null) {
  if (!device) return payTypes.filter(pt => pt.status === 1).sort((a, b) => a.sort - b.sort);
  const deviceCode = device === 'mobile' ? 2 : 1;
  return payTypes.filter(pt => pt.status === 1 && (pt.device === 0 || pt.device === deviceCode)).sort((a, b) => a.sort - b.sort);
}

function getPayTypeById(id) {
  return payTypes.find(pt => pt.id === id) || null;
}

// 格式化日期时间为中国时区 (UTC+8)
function formatDateTimeCN(date) {
    if (!date) return null;
    const d = new Date(date);
    // 转换为 UTC+8
    const offset = 8 * 60 * 60 * 1000;
    const cnDate = new Date(d.getTime() + offset);
    return cnDate.toISOString().replace('T', ' ').substring(0, 19);
}

// 认证中间件（支持 RAM 用户）
const authMiddleware = async (req, res, next) => {
    const sessionId = req.cookies.sessionId;
    if (!sessionId) {
        return res.json({ code: -401, msg: '未登录' });
    }

    const [sessions] = await db.query(
        'SELECT s.user_id FROM sessions s WHERE s.session_token = ?',
        [sessionId]
    );

    if (sessions.length === 0) {
        return res.json({ code: -401, msg: '会话无效' });
    }

    const sessionUserId = sessions[0].user_id;
    let actualUserId = sessionUserId;
    let ramUser = null;

    // 检查是否是 RAM 用户）3位纯数字）
    if (/^\d{13}$/.test(sessionUserId)) {
        const [ramUsers] = await db.query(
            'SELECT * FROM user_ram WHERE user_id = ? AND owner_type = ?',
            [sessionUserId, 'admin']
        );
        if (ramUsers.length > 0 && ramUsers[0].status === 1) {
            ramUser = ramUsers[0];
            actualUserId = ramUser.owner_id;  // 使用主账户的 user_id
        } else {
            return res.json({ code: -403, msg: '子账户无权访问' });
        }
    }

    req.user = { user_id: actualUserId };
    req.ramUser = ramUser;
    next();
};

// RAM 权限检查中间件：需要 channel 权限
const requireChannelPermission = (req, res, next) => {
    // 非 RAM 用户（主账户）拥有所有权限
    if (!req.ramUser) {
        return next();
    }
    
    // permissions 在数据库中存储为 JSON 字符串
    let userPerms = req.ramUser.permissions || [];
    if (typeof userPerms === 'string') {
        try {
            userPerms = JSON.parse(userPerms);
        } catch (e) {
            userPerms = [];
        }
    }
    
    // admin 权限拥有所有权限
    if (userPerms.includes('admin') || userPerms.includes('channel')) {
        return next();
    }
    
    return res.json({ code: -403, msg: '无权限执行此操作' });
};

router.use(authMiddleware);
router.use(requireChannelPermission);

// ============ 支付方式管理 ============

/**
 * 获取所有支付方式
 */
router.get('/pay-types', async (req, res) => {
    try {
        const payTypes = getAllPayTypes();
        res.json({ code: 0, data: payTypes });
    } catch (error) {
        console.error('获取支付方式错误:', error);
        res.json({ code: -1, msg: '获取失败' });
    }
});

// ============ 通道轮询组管理============

/**
 * 获取通道轮询组列表
 */
router.get('/channel-groups', async (req, res) => {
    try {
        const { pay_type_id } = req.query;
        
        let sql = `
            SELECT cg.*
            FROM channel_groups cg
            WHERE 1=1
        `;
        const params = [];
        
        if (pay_type_id) {
            sql += ' AND cg.pay_type_id = ?';
            params.push(pay_type_id);
        }
        
        sql += ' ORDER BY cg.id DESC';
        
        const [groups] = await db.query(sql, params);
        
        // 从配置文件获取支付类型信息并格式化
        const result = groups.map(g => {
            const payType = getPayTypeById(g.pay_type_id);
            return {
                ...g,
                pay_type_name: payType?.name || null,
                pay_type_showname: payType?.showname || null,
                channels: g.channels ? JSON.parse(g.channels) : [],
                created_at: g.created_at ? formatDateTimeCN(g.created_at) : null
            };
        });
        
        res.json({ code: 0, data: result });
    } catch (error) {
        console.error('获取通道轮询组错误:', error);
        res.json({ code: -1, msg: '获取失败' });
    }
});

/**
 * 创建通道轮询组
 */
router.post('/channel-groups/create', async (req, res) => {
    try {
        const { name, mode, channels } = req.body;
        
        if (!name) {
            return res.json({ code: -1, msg: '请填写组名称' });
        }
        
        await db.query(
            `INSERT INTO channel_groups (name, mode, channels, status)
             VALUES (?, ?, ?, 1)`,
            [name, mode || 0, JSON.stringify(channels || [])]
        );
        
        res.json({ code: 0, msg: '创建成功' });
    } catch (error) {
        console.error('创建通道轮询组错误:', error);
        res.json({ code: -1, msg: '创建失败' });
    }
});

/**
 * 更新通道轮询组
 */
router.post('/channel-groups/update', async (req, res) => {
    try {
        const { id, name, mode, channels, status } = req.body;
        
        const updates = [];
        const params = [];
        
        if (name !== undefined) {
            updates.push('name = ?');
            params.push(name);
        }
        if (mode !== undefined) {
            updates.push('mode = ?');
            params.push(mode);
        }
        if (channels !== undefined) {
            updates.push('channels = ?');
            params.push(JSON.stringify(channels));
        }
        if (status !== undefined) {
            updates.push('status = ?');
            params.push(status);
        }
        
        if (updates.length === 0) {
            return res.json({ code: -1, msg: '无更新内容' });
        }
        
        params.push(id);
        
        await db.query(
            `UPDATE channel_groups SET ${updates.join(', ')} WHERE id = ?`,
            params
        );
        
        res.json({ code: 0, msg: '更新成功' });
    } catch (error) {
        console.error('更新通道轮询组错误:', error);
        res.json({ code: -1, msg: '更新失败' });
    }
});

/**
 * 删除通道轮询组
 */
router.post('/channel-groups/delete', async (req, res) => {
    try {
        const { id } = req.body;
        
        await db.query(
            'DELETE FROM channel_groups WHERE id = ?',
            [id]
        );
        
        res.json({ code: 0, msg: '删除成功' });
    } catch (error) {
        console.error('删除通道轮询组错误:', error);
        res.json({ code: -1, msg: '删除失败' });
    }
});

// ============ 支付组配置管理============

/**
 * 获取支付组列表
 */
router.get('/pay-groups', async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT * FROM provider_pay_groups ORDER BY is_default DESC, id ASC'
        );
        
        // 解析config JSON 并格式化时间
        rows.forEach(row => {
            row.config = row.config ? JSON.parse(row.config) : {};
            // 格式化时间为 +8 时区
            if (row.created_at) {
                row.created_at = formatDateTimeCN(row.created_at);
            }
            if (row.updated_at) {
                row.updated_at = formatDateTimeCN(row.updated_at);
            }
        });
        
        res.json({ code: 0, data: rows });
    } catch (error) {
        console.error('获取支付组错误:', error);
        res.json({ code: -1, msg: '获取失败' });
    }
});

/**
 * 创建支付宝'
 */
router.post('/pay-groups/create', async (req, res) => {
    try {
        const { name, is_default, config } = req.body;
        
        if (!name) {
            return res.json({ code: -1, msg: '请输入组名称' });
        }
        
        // 如果设为默认，先取消其他默认组
        if (is_default) {
            await db.query(
                'UPDATE provider_pay_groups SET is_default = 0'
            );
        }
        
        await db.query(
            `INSERT INTO provider_pay_groups (name, is_default, config)
             VALUES (?, ?, ?)`,
            [name, is_default ? 1 : 0, JSON.stringify(config || {})]
        );
        
        res.json({ code: 0, msg: '创建成功' });
    } catch (error) {
        console.error('创建支付组错误:', error);
        res.json({ code: -1, msg: '创建失败' });
    }
});

/**
 * 更新支付宝'
 */
router.post('/pay-groups/update', async (req, res) => {
    try {
        const { id, name, is_default, config } = req.body;
        
        const updates = [];
        const params = [];
        
        if (name !== undefined) {
            updates.push('name = ?');
            params.push(name);
        }
        if (is_default !== undefined) {
            // 如果设为默认，先取消其他默认组
            if (is_default) {
                await db.query(
                    'UPDATE provider_pay_groups SET is_default = 0'
                );
            }
            updates.push('is_default = ?');
            params.push(is_default ? 1 : 0);
        }
        if (config !== undefined) {
            updates.push('config = ?');
            params.push(JSON.stringify(config));
        }
        
        if (updates.length === 0) {
            return res.json({ code: -1, msg: '无更新内容' });
        }
        
        params.push(id);
        
        await db.query(
            `UPDATE provider_pay_groups SET ${updates.join(', ')} WHERE id = ?`,
            params
        );
        
        res.json({ code: 0, msg: '更新成功' });
    } catch (error) {
        console.error('更新支付组错误:', error);
        res.json({ code: -1, msg: '更新失败' });
    }
});

/**
 * 删除支付宝'
 */
router.post('/pay-groups/delete', async (req, res) => {
    try {
        const { id } = req.body;
        
        // 检查是否是默认组
        const [[group]] = await db.query(
            'SELECT is_default FROM provider_pay_groups WHERE id = ?',
            [id]
        );
        
        if (group && group.is_default) {
            return res.json({ code: -1, msg: '不能删除默认组，请先设置其他组为默认组' });
        }
        
        // 检查是否有商户在使用
        const [[usage]] = await db.query(
            'SELECT COUNT(*) as count FROM merchants WHERE pay_group_id = ?',
            [id]
        );
        
        if (usage.count > 0) {
            return res.json({ code: -1, msg: `该支付组正被 ${usage.count} 个商户使用，无法删除` });
        }
        
        await db.query(
            'DELETE FROM provider_pay_groups WHERE id = ?',
            [id]
        );
        
        res.json({ code: 0, msg: '删除成功' });
    } catch (error) {
        console.error('删除支付组错误:', error);
        res.json({ code: -1, msg: '删除失败' });
    }
});

/**
 * 设置默认支付宝'
 */
router.post('/pay-groups/set-default', async (req, res) => {
    try {
        const { id } = req.body;
        
        // 取消其他默认组
        await db.query(
            'UPDATE provider_pay_groups SET is_default = 0'
        );
        
        // 设置新的默认组
        await db.query(
            'UPDATE provider_pay_groups SET is_default = 1 WHERE id = ?',
            [id]
        );
        
        res.json({ code: 0, msg: '设置成功' });
    } catch (error) {
        console.error('设置默认支付组错误:', error);
        res.json({ code: -1, msg: '设置失败' });
    }
});

/**
 * 获取支付组详情（包含关联的通道和轮询组）
 */
router.get('/pay-groups/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // 获取支付宝'
        const [[group]] = await db.query(
            'SELECT * FROM provider_pay_groups WHERE id = ?',
            [id]
        );
        
        if (!group) {
            return res.json({ code: -1, msg: '支付组不存在' });
        }
        
        group.config = group.config ? JSON.parse(group.config) : {};
        
        // 从配置文件获取所有支付方式
        const payTypes = getAllPayTypes();
        
        // 获取所有通道
        const [channels] = await db.query(
            'SELECT id, channel_name, pay_type, plugin_name, status FROM provider_channels'
        );
        
        // 获取所有轮询组
        const [channelGroups] = await db.query(
            'SELECT id, name, pay_type_id, status FROM channel_groups'
        );
        
        res.json({
            code: 0,
            data: {
                group,
                payTypes,
                channels,
                channelGroups
            }
        });
    } catch (error) {
        console.error('获取支付组详情错误:', error);
        res.json({ code: -1, msg: '获取失败' });
    }
});

/**
 * 更新商户的支付组
 */
router.post('/merchants/set-pay-group', async (req, res) => {
    try {
        const { merchant_id, pay_group_id } = req.body;
        
        await db.query(
            'UPDATE merchants SET pay_group_id = ? WHERE id = ?',
            [pay_group_id || null, merchant_id]
        );
        
        res.json({ code: 0, msg: '设置成功' });
    } catch (error) {
        console.error('设置商户支付组错误:', error);
        res.json({ code: -1, msg: '设置失败' });
    }
});

module.exports = router;
