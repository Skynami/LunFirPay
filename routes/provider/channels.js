/**
 * Provider 通道管理路由
 */
const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const pluginLoader = require('../../utils/pluginLoader');
const { requireProviderRamPermission } = require('../auth');

// 获取支付通道列表（需要 channel 权限）
router.get('/channels', requireProviderRamPermission('channel'), async (req, res) => {
  try {
    const { type } = req.query;

    // 排除 config 敏感配置字段
    let sql = `SELECT id, channel_id, channel_name, plugin_name, pay_type, 
               cost_rate, min_money, max_money, day_limit, time_start, time_stop, priority, status, apptype, notify_url, created_at
               FROM provider_channels WHERE (is_deleted = 0 OR is_deleted IS NULL)`;
    const params = [];

    if (type) {
      sql += ' AND pay_type = ?';
      params.push(type);
    }

    sql += ' ORDER BY priority DESC, created_at DESC';

    const [channels] = await db.query(sql, params);

    // 获取今日每个通道的已用额度（单服务商模式，不按 provider_id 过滤）
    const [todayUsage] = await db.query(
      `SELECT channel_id, COALESCE(SUM(money), 0) as used_amount 
       FROM orders 
       WHERE status = 1 AND DATE(created_at) = CURDATE()
       GROUP BY channel_id`
    );
    const usageMap = {};
    todayUsage.forEach(u => { usageMap[u.channel_id] = parseFloat(u.used_amount) || 0; });

    // 转换字段名以匹配前端期望
    const list = channels.map(c => {
      const dayLimit = parseFloat(c.day_limit) || 0;
      const usedToday = usageMap[c.id] || 0;
      const remaining = dayLimit > 0 ? Math.max(0, dayLimit - usedToday) : -1; // -1 表示无限制
      
      return {
        ...c,
        name: c.channel_name,
        plugin: c.plugin_name,
        type: c.pay_type,
        notify_url: c.notify_url || '',
        day_used: usedToday,
        day_remaining: remaining
      };
    });

    res.json({ code: 0, data: list });
  } catch (error) {
    console.error('获取通道列表错误:', error);
    res.json({ code: -1, msg: '获取通道列表失败' });
  }
});

// 获取可用插件列表（需要 channel 权限）
router.get('/plugins', requireProviderRamPermission('channel'), async (req, res) => {
  try {
    // 使用新的 getPluginList 方法，返回完整的插件配置信息
    const list = pluginLoader.getPluginList();
    res.json({ code: 0, data: list });
  } catch (error) {
    console.error('获取插件列表错误:', error);
    res.json({ code: -1, msg: '获取插件列表失败' });
  }
});

// 创建支付通道（需要 channel 权限）
router.post('/channels/create', requireProviderRamPermission('channel'), async (req, res) => {
  try {
    const { name, plugin, pay_type, cost_rate, min_money, max_money, day_limit, time_start, time_stop, priority, status, config, notify_url } = req.body;

    if (!name || !plugin) {
      return res.json({ code: -1, msg: '请填写完整信息' });
    }

    // 验证时间范围
    const timeStartVal = (time_start !== undefined && time_start !== null && time_start !== '') ? parseInt(time_start) : null;
    const timeStopVal = (time_stop !== undefined && time_stop !== null && time_stop !== '') ? parseInt(time_stop) : null;
    if (timeStartVal !== null && (timeStartVal < 0 || timeStartVal > 23)) {
      return res.json({ code: -1, msg: '开始时间必须在0-23之间' });
    }
    if (timeStopVal !== null && (timeStopVal < 0 || timeStopVal > 23)) {
      return res.json({ code: -1, msg: '结束时间必须在0-23之间' });
    }

    // 解析 config，提取 apptype
    let configObj = {};
    let apptypeStr = '';
    if (config) {
      try {
        configObj = typeof config === 'string' ? JSON.parse(config) : config;
        if (configObj.apptype && Array.isArray(configObj.apptype)) {
          apptypeStr = configObj.apptype.join(',');
        }
      } catch (e) {
        console.error('解析配置失败:', e);
      }
    }

    // 获取下一个 channel_id
    const [[maxId]] = await db.query(
      'SELECT COALESCE(MAX(channel_id), 0) + 1 as next_id FROM provider_channels'
    );
    const nextChannelId = maxId.next_id;

    await db.query(
      `INSERT INTO provider_channels 
       (channel_id, channel_name, plugin_name, pay_type, cost_rate, min_money, max_money, day_limit, time_start, time_stop, priority, status, config, apptype, notify_url) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [nextChannelId, name, plugin, pay_type || 'alipay', cost_rate || 0, min_money || 0, max_money || 0, day_limit || 0, timeStartVal, timeStopVal, priority || 0, status ?? 1, config || null, apptypeStr, notify_url || null]
    );

    res.json({ code: 0, msg: '创建成功' });
  } catch (error) {
    console.error('创建通道错误:', error);
    res.json({ code: -1, msg: '创建失败: ' + error.message });
  }
});

// 更新支付通道（需要 channel 权限）
router.post('/channels/update', requireProviderRamPermission('channel'), async (req, res) => {
  try {
    const { id, name, pay_type, cost_rate, min_money, max_money, day_limit, time_start, time_stop, priority, status, config, notify_url } = req.body;

    const updates = [];
    const params = [];

    if (name !== undefined) {
      updates.push('channel_name = ?');
      params.push(name);
    }
    if (pay_type !== undefined) {
      updates.push('pay_type = ?');
      params.push(pay_type);
    }
    if (cost_rate !== undefined) {
      updates.push('cost_rate = ?');
      params.push(cost_rate);
    }
    if (min_money !== undefined) {
      updates.push('min_money = ?');
      params.push(min_money);
    }
    if (max_money !== undefined) {
      updates.push('max_money = ?');
      params.push(max_money);
    }
    if (day_limit !== undefined) {
      updates.push('day_limit = ?');
      params.push(day_limit);
    }
    if (time_start !== undefined) {
      const val = (time_start !== null && time_start !== '') ? parseInt(time_start) : null;
      if (val !== null && (val < 0 || val > 23)) {
        return res.json({ code: -1, msg: '开始时间必须在0-23之间' });
      }
      updates.push('time_start = ?');
      params.push(val);
    }
    if (time_stop !== undefined) {
      const val = (time_stop !== null && time_stop !== '') ? parseInt(time_stop) : null;
      if (val !== null && (val < 0 || val > 23)) {
        return res.json({ code: -1, msg: '结束时间必须在0-23之间' });
      }
      updates.push('time_stop = ?');
      params.push(val);
    }
    if (priority !== undefined) {
      updates.push('priority = ?');
      params.push(priority);
    }
    if (status !== undefined) {
      updates.push('status = ?');
      params.push(status);
    }
    if (notify_url !== undefined) {
      updates.push('notify_url = ?');
      params.push(notify_url || null);
    }
    if (config !== undefined) {
      updates.push('config = ?');
      params.push(config);
      
      // 从 config 中提取 apptype
      try {
        const configObj = typeof config === 'string' ? JSON.parse(config) : config;
        if (configObj.apptype && Array.isArray(configObj.apptype)) {
          updates.push('apptype = ?');
          params.push(configObj.apptype.join(','));
        }
      } catch (e) {}
    }

    if (updates.length === 0) {
      return res.json({ code: -1, msg: '无更新内容' });
    }

    // 单服务商模式，不按 provider_id 过滤
    params.push(id);

    await db.query(
      `UPDATE provider_channels SET ${updates.join(', ')} WHERE id = ?`,
      params
    );

    res.json({ code: 0, msg: '更新成功' });
  } catch (error) {
    console.error('更新通道错误:', error);
    res.json({ code: -1, msg: '更新失败' });
  }
});

// 获取单个通道详情（包含config敏感配置，用于编辑）（需要 channel 权限）
router.get('/channels/:id', requireProviderRamPermission('channel'), async (req, res) => {
  try {
    const { id } = req.params;

    // 单服务商模式，不按 provider_id 过滤
    const [channels] = await db.query(
      'SELECT * FROM provider_channels WHERE id = ? AND (is_deleted = 0 OR is_deleted IS NULL)',
      [id]
    );

    if (channels.length === 0) {
      return res.json({ code: -1, msg: '通道不存在' });
    }

    res.json({ code: 0, data: channels[0] });
  } catch (error) {
    console.error('获取通道详情错误:', error);
    res.json({ code: -1, msg: '获取失败' });
  }
});

// 删除支付通道（软删除）（需要 channel 权限）
router.post('/channels/delete', requireProviderRamPermission('channel'), async (req, res) => {
  try {
    const { id } = req.body;

    // 单服务商模式，不按 provider_id 过滤（软删除）
    await db.query(
      'UPDATE provider_channels SET is_deleted = 1 WHERE id = ?',
      [id]
    );

    res.json({ code: 0, msg: '删除成功' });
  } catch (error) {
    console.error('删除通道错误:', error);
    res.json({ code: -1, msg: '删除失败' });
  }
});

// 获取插件配置schema（需要 channel 权限）
router.get('/plugin-config', requireProviderRamPermission('channel'), async (req, res) => {
  try {
    const { plugin, channelId } = req.query;

    const pluginInstance = pluginLoader.getPlugin(plugin);
    if (!pluginInstance) {
      return res.json({ code: -1, msg: '插件不存在' });
    }

    // 构建配置字段
    const fields = [];
    const inputs = pluginInstance.info.inputs || {};
    
    for (const [key, config] of Object.entries(inputs)) {
      fields.push({
        name: key,
        label: config.name,
        type: config.type === 'textarea' ? 'textarea' : (config.type === 'select' ? 'select' : 'text'),
        placeholder: config.note || '',
        tip: config.note || '',
        options: config.options || []
      });
    }

    // 获取已保存的配置值（单服务商模式，不按 provider_id 过滤）
    let values = {};
    if (channelId) {
      const [channels] = await db.query(
        'SELECT config FROM provider_channels WHERE id = ?',
        [channelId]
      );
      if (channels.length > 0 && channels[0].config) {
        try {
          values = JSON.parse(channels[0].config);
        } catch (e) {}
      }
    }

    res.json({
      code: 0,
      data: {
        schema: { fields },
        values
      }
    });
  } catch (error) {
    console.error('获取插件配置错误:', error);
    res.json({ code: -1, msg: '获取配置失败' });
  }
});

// 保存通道配置（需要 channel 权限）
router.post('/channels/config', requireProviderRamPermission('channel'), async (req, res) => {
  try {
    const { channelId, config } = req.body;

    // 单服务商模式，不按 provider_id 过滤
    await db.query(
      'UPDATE provider_channels SET config = ? WHERE id = ?',
      [JSON.stringify(config), channelId]
    );

    res.json({ code: 0, msg: '配置保存成功' });
  } catch (error) {
    console.error('保存通道配置错误:', error);
    res.json({ code: -1, msg: '保存失败' });
  }
});

module.exports = router;
