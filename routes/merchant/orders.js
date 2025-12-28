/**
 * 商户订单路由
 */
const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const { sendNotify } = require('../../utils/payment');

/**
 * 获取权限检查中间件（从 auth.js 导入）
 */
const { requireMerchantRamPermission } = require('../auth');

// 获取订单列表
router.get('/orders', requireMerchantRamPermission('order'), async (req, res) => {
  try {
    const { user_id } = req.user;
    const { page = 1, pageSize = 20, status, startDate, endDate, tradeNo } = req.query;
    
    // 只输出商户需要的字段
    let sql = `SELECT o.id, o.trade_no, o.out_trade_no, o.pay_type, o.name, 
               o.money, o.fee_money, o.fee_payer, o.notify_url, o.return_url, 
               o.status, o.created_at, o.paid_at, o.refund_status, o.refund_money,
               o.notify_status, o.notify_count, o.notify_time, o.merchant_confirm, o.order_type
               FROM orders o
               WHERE o.merchant_id = ?`;
    const params = [user_id];

    if (status !== undefined && status !== '') {
      sql += ' AND o.status = ?';
      params.push(status);
    }

    if (startDate) {
      sql += ' AND DATE(o.created_at) >= ?';
      params.push(startDate);
    }

    if (endDate) {
      sql += ' AND DATE(o.created_at) <= ?';
      params.push(endDate);
    }

    if (tradeNo) {
      sql += ' AND (o.trade_no LIKE ? OR o.out_trade_no LIKE ?)';
      params.push(`%${tradeNo}%`, `%${tradeNo}%`);
    }

    // 获取总数
    const countSql = sql.replace(/SELECT.*?FROM orders o/s, 'SELECT COUNT(*) as total FROM orders o');
    const [countResult] = await db.query(countSql, params);
    const total = countResult[0].total;

    // 分页
    sql += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(pageSize), (parseInt(page) - 1) * parseInt(pageSize));
    const [orders] = await db.query(sql, params);

    res.json({
      code: 0,
      data: {
        list: orders,
        total,
        page: parseInt(page),
        pageSize: parseInt(pageSize)
      }
    });
  } catch (error) {
    console.error('获取订单错误:', error);
    res.json({ code: -1, msg: '获取订单失败' });
  }
});

// 申请退款（直接调用支付插件进行原路退款）
router.post('/refund', requireMerchantRamPermission('finance'), async (req, res) => {
  try {
    const { user_id } = req.user;
    const { tradeNo, money, reason } = req.body;
    
    // 检查系统是否开启商户自助退款
    const systemConfig = require('../../utils/systemConfig');
    const userRefund = await systemConfig.getConfig('user_refund', '0');
    if (userRefund !== '1') {
      return res.json({ code: -1, msg: '管理员未开启商户自助退款功能' });
    }

    // 查询订单
    const [orders] = await db.query(
      'SELECT * FROM orders WHERE trade_no = ? AND merchant_id = ?',
      [tradeNo, user_id]
    );

    if (orders.length === 0) {
      return res.json({ code: -1, msg: '订单不存在' });
    }

    const order = orders[0];

    // 检查订单状态：已支付(1)、已退款但有剩余(2)、已冻结(3) 可以退款
    if (![1, 2, 3].includes(order.status)) {
      return res.json({ code: -1, msg: '订单状态不允许退款' });
    }

    // 已退款订单检查剩余可退金额
    const refundedMoney = parseFloat(order.refund_money || 0);
    const realMoney = parseFloat(order.real_money || order.money);
    
    if (order.status === 2 && refundedMoney <= 0) {
      return res.json({ code: -1, msg: '订单已全额退款' });
    }
    
    if (order.status === 2 && refundedMoney >= realMoney) {
      return res.json({ code: -1, msg: '订单已全额退款' });
    }

    const refundMoney = parseFloat(money);
    if (isNaN(refundMoney) || refundMoney <= 0) {
      return res.json({ code: -1, msg: '退款金额无效' });
    }
    
    const maxRefund = order.status === 2 ? (realMoney - refundedMoney) : realMoney;
    if (refundMoney > maxRefund) {
      return res.json({ code: -1, msg: `退款金额不能超过${maxRefund.toFixed(2)}元` });
    }

    // 检查是否有上游交易号（只有有上游交易号才能原路退款）
    if (!order.api_trade_no) {
      return res.json({ code: -1, msg: '该订单没有上游交易号，无法原路退款' });
    }

    // 获取支付通道信息
    const [channels] = await db.query(
      'SELECT * FROM provider_channels WHERE id = ?',
      [order.channel_id]
    );

    if (channels.length === 0) {
      return res.json({ code: -1, msg: '支付通道不存在' });
    }

    const channel = channels[0];
    
    // 检查插件是否支持退款
    const pluginLoader = require('../../plugins');
    const plugin = pluginLoader.getPlugin(channel.plugin_name);
    
    if (!plugin) {
      return res.json({ code: -1, msg: '支付插件不存在' });
    }
    
    if (typeof plugin.refund !== 'function') {
      return res.json({ code: -1, msg: '该支付通道不支持原路退款' });
    }

    // 计算需要扣减的商户余额
    let reduceMoney;
    const orderMoney = parseFloat(order.money);
    const feeMoney = parseFloat(order.fee_money || 0);
    const merchantReceived = orderMoney - feeMoney;  // 商户实收金额
    
    // 已冻结订单不扣余额
    if (order.status === 3) {
      reduceMoney = 0;
    } else if (refundMoney >= orderMoney) {
      // 全额退款：扣除商户实收金额
      reduceMoney = merchantReceived;
    } else {
      // 部分退款：按比例扣除（退款金额/订单金额 * 实收金额）
      reduceMoney = (refundMoney / orderMoney) * merchantReceived;
    }
    
    reduceMoney = Math.round(reduceMoney * 100) / 100;  // 保留2位小数

    // 检查商户余额是否足够
    if (reduceMoney > 0) {
      const [merchants] = await db.query(
        'SELECT balance FROM merchants WHERE user_id = ?',
        [user_id]
      );
      
      if (merchants.length === 0 || parseFloat(merchants[0].balance) < reduceMoney) {
        return res.json({ code: -1, msg: `商户余额不足（需要 ¥${reduceMoney.toFixed(2)}）` });
      }
    }

    // 生成退款单号
    const refundNo = 'R' + Date.now() + Math.random().toString(36).substr(2, 6).toUpperCase();

    // 解析通道配置
    let channelConfig;
    try {
      channelConfig = channel.config ? JSON.parse(channel.config) : {};
    } catch (e) {
      channelConfig = {};
    }
    
    // 合并通道配置
    const fullConfig = {
      ...channelConfig,
      appid: channel.app_id,
      appmchid: channel.app_mch_id,
      appkey: channel.app_key,
      appsecret: channel.app_secret
    };

    // 调用插件退款
    try {
      const refundResult = await plugin.refund(fullConfig, {
        trade_no: order.trade_no,
        api_trade_no: order.api_trade_no,
        refund_no: refundNo,
        refund_money: refundMoney,
        total_money: realMoney
      });

      if (refundResult.code !== 0) {
        return res.json({ code: -1, msg: '退款失败：' + (refundResult.msg || '未知错误') });
      }

      // 使用事务处理余额扣减和订单状态更新
      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();

        // 扣减商户余额
        if (reduceMoney > 0) {
          await connection.query(
            'UPDATE merchants SET balance = balance - ? WHERE user_id = ?',
            [reduceMoney, user_id]
          );
        }

        // 更新订单状态
        const newRefundMoney = refundedMoney + refundMoney;
        await connection.query(
          `UPDATE orders SET 
            status = 2, 
            refund_status = 1,
            refund_no = ?,
            refund_money = ?, 
            refund_reason = ?,
            refund_at = NOW()
           WHERE id = ?`,
          [refundNo, newRefundMoney, reason || '商户发起退款', order.id]
        );

        await connection.commit();
      } catch (txError) {
        await connection.rollback();
        throw txError;
      } finally {
        connection.release();
      }

      res.json({ 
        code: 0, 
        msg: '退款成功',
        data: { 
          tradeNo, 
          refundNo,
          refundMoney: refundMoney.toFixed(2),
          reduceMoney: reduceMoney.toFixed(2)
        } 
      });

    } catch (pluginError) {
      console.error('调用退款插件错误:', pluginError);
      return res.json({ code: -1, msg: '退款失败：' + pluginError.message });
    }

  } catch (error) {
    console.error('商户退款错误:', error);
    res.json({ code: -1, msg: '退款失败：' + error.message });
  }
});

// 查询订单退款信息（用于弹窗显示）
router.post('/refund/query', async (req, res) => {
  try {
    const { user_id } = req.user;
    const { tradeNo } = req.body;

    // 检查系统是否开启商户自助退款
    const systemConfig = require('../../utils/systemConfig');
    const userRefund = await systemConfig.getConfig('user_refund', '0');
    if (userRefund !== '1') {
      return res.json({ code: -1, msg: '管理员未开启商户自助退款功能' });
    }

    const [orders] = await db.query(
      'SELECT trade_no, money, real_money, refund_money, status, api_trade_no, channel_id FROM orders WHERE trade_no = ? AND merchant_id = ?',
      [tradeNo, user_id]
    );

    if (orders.length === 0) {
      return res.json({ code: -1, msg: '订单不存在' });
    }

    const order = orders[0];

    // 检查是否可退款
    if (![1, 2, 3].includes(order.status)) {
      return res.json({ code: -1, msg: '订单状态不允许退款' });
    }

    if (!order.api_trade_no) {
      return res.json({ code: -1, msg: '该订单没有上游交易号，无法原路退款' });
    }

    // 检查通道是否支持退款
    const [channels] = await db.query(
      'SELECT plugin_name FROM provider_channels WHERE id = ?',
      [order.channel_id]
    );

    if (channels.length === 0) {
      return res.json({ code: -1, msg: '支付通道不存在' });
    }

    const pluginLoader = require('../../plugins');
    const plugin = pluginLoader.getPlugin(channels[0].plugin_name);
    
    if (!plugin || typeof plugin.refund !== 'function') {
      return res.json({ code: -1, msg: '该支付通道不支持原路退款' });
    }

    const refundedMoney = parseFloat(order.refund_money || 0);
    const realMoney = parseFloat(order.real_money || order.money);
    const maxRefund = order.status === 2 ? Math.max(0, realMoney - refundedMoney) : realMoney;

    res.json({ 
      code: 0, 
      data: {
        tradeNo: order.trade_no,
        money: realMoney.toFixed(2),
        refundedMoney: refundedMoney.toFixed(2),
        maxRefund: maxRefund.toFixed(2)
      }
    });

  } catch (error) {
    console.error('查询退款信息错误:', error);
    res.json({ code: -1, msg: '查询失败' });
  }
});

// 普通订单强制回调（商户认账）（需要 order 权限）
router.post('/orders/notify', requireMerchantRamPermission('order'), async (req, res) => {
  try {
    const { user_id } = req.user;
    const merchant = req.merchant;
    const { tradeNo } = req.body;

    if (!tradeNo) {
      return res.json({ code: -1, msg: '缺少订单号' });
    }

    // 查询普通订单
    const [orders] = await db.query(
      'SELECT * FROM orders WHERE trade_no = ? AND merchant_id = ?',
      [tradeNo, user_id]
    );

    if (orders.length === 0) {
      return res.json({ code: -1, msg: '订单不存在' });
    }

    const order = orders[0];

    // 检查订单状态：未支付或已过期的订单可以商户认账
    if (order.status !== 0 && order.status !== 2) {
      return res.json({ code: -1, msg: '只有未支付或已过期订单可以商户认账回调' });
    }

    if (!order.notify_url) {
      return res.json({ code: -1, msg: '订单未设置回调地址' });
    }

    // 标记为商户确认（认账），同时将状态改为未支付(0)以便后续状态显示正确
    await db.query(
      'UPDATE orders SET merchant_confirm = 1, status = 0 WHERE id = ?',
      [order.id]
    );

    // 获取商户PID（单服务商模式：直接使用 merchants.pid）
    const [providerMerchants] = await db.query(
      'SELECT pid FROM merchants WHERE user_id = ? LIMIT 1',
      [user_id]
    );

    if (providerMerchants.length === 0) {
      return res.json({ code: -1, msg: '商户信息不存在' });
    }

    const pm = providerMerchants[0];
    
    // 构建回调参数（模拟支付成功）
    const notifyOrder = { ...order, status: 1 };  // 模拟已支付状态
    const notifyParams = {
      pid: pm.pid,
      trade_no: order.trade_no,
      out_trade_no: order.out_trade_no,
      type: order.pay_type || 'unknown',
      name: order.name || '',
      money: parseFloat(order.money).toFixed(2),
      trade_status: 'TRADE_SUCCESS'
    };
    
    // 使用商户自己的 api_key 签名
    const { makeSign } = require('../../utils/payment');
    notifyParams.sign = makeSign(notifyParams, merchant.api_key);
    notifyParams.sign_type = 'MD5';

    // 发送回调
    const success = await sendNotify(order.notify_url, notifyParams);
    
    // 更新回调状态
    await db.query(
      'UPDATE orders SET notify_status = ?, notify_count = notify_count + 1, notify_time = NOW() WHERE id = ?',
      [success ? 1 : 2, order.id]
    );

    if (success) {
      res.json({ code: 0, msg: '认账成功，回调已送达' });
    } else {
      res.json({ code: 0, msg: '认账成功，但回调失败，请稍后重试回调' });
    }
  } catch (error) {
    console.error('普通订单回调错误:', error);
    res.json({ code: -1, msg: '操作失败: ' + error.message });
  }
});

// 已支付普通订单重发回调（需要 order 权限）
router.post('/orders/resend-notify', requireMerchantRamPermission('order'), async (req, res) => {
  try {
    const { user_id } = req.user;
    const merchant = req.merchant;
    const { tradeNo } = req.body;

    if (!tradeNo) {
      return res.json({ code: -1, msg: '缺少订单号' });
    }

    // 查询普通订单
    const [orders] = await db.query(
      'SELECT * FROM orders WHERE trade_no = ? AND merchant_id = ?',
      [tradeNo, user_id]
    );

    if (orders.length === 0) {
      return res.json({ code: -1, msg: '订单不存在' });
    }

    const order = orders[0];

    // 检查订单状态：已支付的订单，或已认账的订单可以重发回调
    if (order.status !== 1 && !(order.status === 0 && order.merchant_confirm === 1)) {
      return res.json({ code: -1, msg: '只有已支付或已认账订单可以重发回调' });
    }

    if (!order.notify_url) {
      return res.json({ code: -1, msg: '订单未设置回调地址' });
    }

    // 获取商户PID（API使用的12位随机ID）
    const [providerMerchants] = await db.query(
      'SELECT pid FROM merchants WHERE user_id = ? LIMIT 1',
      [user_id]
    );

    if (providerMerchants.length === 0) {
      return res.json({ code: -1, msg: '商户信息不存在' });
    }

    const pm = providerMerchants[0];
    
    // 构建回调参数
    const notifyParams = {
      pid: pm.pid,
      trade_no: order.trade_no,
      out_trade_no: order.out_trade_no,
      type: order.pay_type || 'unknown',
      name: order.name || '',
      money: parseFloat(order.money).toFixed(2),
      trade_status: 'TRADE_SUCCESS'
    };
    
    // 使用商户自己的 api_key 签名
    const { makeSign } = require('../../utils/payment');
    notifyParams.sign = makeSign(notifyParams, merchant.api_key);
    notifyParams.sign_type = 'MD5';

    // 发送回调
    const success = await sendNotify(order.notify_url, notifyParams);
    
    // 更新回调状态
    await db.query(
      'UPDATE orders SET notify_status = ?, notify_count = notify_count + 1, notify_time = NOW() WHERE id = ?',
      [success ? 1 : 2, order.id]
    );

    if (success) {
      res.json({ code: 0, msg: '回调成功' });
    } else {
      res.json({ code: -1, msg: '回调失败：商户服务器未返回 success' });
    }
  } catch (error) {
    console.error('重发回调错误:', error);
    res.json({ code: -1, msg: '操作失败: ' + error.message });
  }
});

module.exports = router;
