/**
 * 商户结算 & 提现路由
 */
const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const telegramService = require('../../Telegram');

const { requireMerchantRamPermission } = require('../auth');

// ==================== 结算相关接口 ====================

// 获取总余额（所有服务商余额之和）
router.get('/balance/total', async (req, res) => {
  try {
    const { user_id } = req.user;
    
    const [result] = await db.query(
      'SELECT COALESCE(SUM(balance), 0) as total_balance FROM merchants WHERE user_id = ?',
      [user_id]
    );
    
    res.json({ code: 0, data: { balance: parseFloat(result[0].total_balance || 0) } });
  } catch (error) {
    console.error('获取总余额错误:', error);
    res.json({ code: -1, msg: '获取余额失败' });
  }
});

// 获取商户余额信息（单服务商模式）
router.get('/services/list', async (req, res) => {
  try {
    const { user_id } = req.user;
    
    // 单服务商模式：简化查询，不再关联 users 表获取 provider 信息
    const [services] = await db.query(`
      SELECT *
      FROM merchants
      WHERE user_id = ?
      ORDER BY id DESC
    `, [user_id]);
    
    res.json({ code: 0, data: services });
  } catch (error) {
    console.error('获取服务商列表错误:', error);
    res.json({ code: -1, msg: '获取列表失败' });
  }
});

// 获取支持的结算方式
router.get('/settlement/options', async (req, res) => {
  try {
    const [options] = await db.query(
      'SELECT * FROM settlement_options LIMIT 1'
    );
    
    if (options.length === 0) {
      // 默认所有方式都开启（加密货币除外）
      return res.json({ code: 0, data: {
        alipay_enabled: 1,
        wxpay_enabled: 1,
        bank_enabled: 1,
        crypto_enabled: 0,
        crypto_networks: []
      }});
    }
    
    const option = options[0];
    // crypto_networks 可能已经是数组（被MySQL驱动解析），或者是字符串
    if (option.crypto_networks) {
      if (typeof option.crypto_networks === 'string') {
        try {
          option.crypto_networks = JSON.parse(option.crypto_networks);
        } catch (e) {
          option.crypto_networks = [];
        }
      }
    } else {
      option.crypto_networks = [];
    }
    
    res.json({ code: 0, data: option });
  } catch (error) {
    console.error('获取结算选项错误:', error);
    res.json({ code: -1, msg: '获取失败' });
  }
});

// 获取商户结算设置
router.get('/settlement/settings', async (req, res) => {
  try {
    const { user_id } = req.user;
    
    const [settings] = await db.query(
      'SELECT * FROM merchant_settlements WHERE merchant_id = ?',
      [user_id]
    );
    
    res.json({ code: 0, data: settings });
  } catch (error) {
    console.error('获取结算设置错误:', error);
    res.json({ code: -1, msg: '获取失败' });
  }
});

// 保存商户结算设置
router.post('/settlement/save', requireMerchantRamPermission('settings'), async (req, res) => {
  try {
    const { user_id } = req.user;
    const { settle_type, account_name, account_no, bank_name, bank_branch, crypto_network, crypto_address, is_default } = req.body;
    
    if (!settle_type) {
      return res.json({ code: -1, msg: '缺少结算类型' });
    }
    
    // 验证商户是否存在
    const [merchants] = await db.query(
      'SELECT id FROM merchants WHERE user_id = ?',
      [user_id]
    );
    
    if (merchants.length === 0) {
      return res.json({ code: -1, msg: '商户不存在' });
    }
    
    // 检查是否已有结算方式（用于判断是否为第一个）
    const [existingAll] = await db.query(
      'SELECT id FROM merchant_settlements WHERE merchant_id = ?',
      [user_id]
    );
    const isFirstSettlement = existingAll.length === 0;
    
    // 如果设为默认或是第一个结算方式，先取消其他默认
    if (is_default || isFirstSettlement) {
      await db.query(
        'UPDATE merchant_settlements SET is_default = 0 WHERE merchant_id = ?',
        [user_id]
      );
    }
    
    // 第一个结算方式自动设为默认
    const shouldBeDefault = is_default || isFirstSettlement;
    
    // 检查是否已存在相同类型的设置
    const [existing] = await db.query(
      'SELECT id FROM merchant_settlements WHERE merchant_id = ? AND settle_type = ?',
      [user_id, settle_type]
    );
    
    if (existing.length > 0) {
      // 更新
      await db.query(`
        UPDATE merchant_settlements SET 
          account_name = ?, account_no = ?, bank_name = ?, bank_branch = ?,
          crypto_network = ?, crypto_address = ?, is_default = ?
        WHERE id = ?
      `, [account_name, account_no, bank_name, bank_branch, crypto_network, crypto_address, shouldBeDefault ? 1 : 0, existing[0].id]);
    } else {
      // 新增
      await db.query(`
        INSERT INTO merchant_settlements 
          (merchant_id, settle_type, account_name, account_no, bank_name, bank_branch, crypto_network, crypto_address, is_default)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [user_id, settle_type, account_name, account_no, bank_name, bank_branch, crypto_network, crypto_address, shouldBeDefault ? 1 : 0]);
    }
    
    res.json({ code: 0, msg: '保存成功' });
  } catch (error) {
    console.error('保存结算设置错误:', error);
    res.json({ code: -1, msg: '保存失败' });
  }
});

// 删除商户结算设置
router.post('/settlement/delete', requireMerchantRamPermission('settings'), async (req, res) => {
  try {
    const { user_id } = req.user;
    const { id } = req.body;
    
    await db.query(
      'DELETE FROM merchant_settlements WHERE id = ? AND merchant_id = ?',
      [id, user_id]
    );
    
    res.json({ code: 0, msg: '删除成功' });
  } catch (error) {
    console.error('删除结算设置错误:', error);
    res.json({ code: -1, msg: '删除失败' });
  }
});

// ===================== 提现申请功能 =====================

// 获取可提现信息
router.get('/withdraw/info', async (req, res) => {
  try {
    const { user_id } = req.user;
    
    // 获取商户余额
    const [pmRows] = await db.query(
      'SELECT balance FROM merchants WHERE user_id = ?',
      [user_id]
    );
    
    if (pmRows.length === 0) {
      return res.json({ code: -1, msg: '商户不存在' });
    }
    
    const balance = parseFloat(pmRows[0].balance || 0);
    
    // 获取结算配置
    const [optRows] = await db.query(
      'SELECT * FROM settlement_options LIMIT 1'
    );
    
    const options = optRows.length > 0 ? optRows[0] : {
      settle_rate: 0,
      settle_fee_min: 0,
      settle_fee_max: 0,
      min_settle_amount: 10,
      settle_cycle: 1
    };
    
    // 计算冻结金额（根据结算周期）
    // settle_cycle: -1=实时, 0=D+0, 1=D+1
    let frozenAmount = 0;
    if (options.settle_cycle === 1 || options.settle_cycle === 0) {
      // D+1 和 D+0: 今天0点之后的收入不可提
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayStart = today.toISOString().slice(0, 19).replace('T', ' ');
      const [orderRows] = await db.query(`
        SELECT COALESCE(SUM(real_money - fee_money), 0) as frozen 
        FROM orders 
        WHERE merchant_id = ? AND status = 1 AND paid_at >= ?
      `, [user_id, todayStart]);
      frozenAmount = parseFloat(orderRows[0].frozen || 0);
    }
    // settle_cycle === -1 (实时): frozenAmount = 0，收入即可提现
    
    // 可提现余额 = 当前余额 - 冻结金额（余额已在申请时扣除，无需计算 pendingAmount）
    let availableBalance = balance - frozenAmount;
    if (availableBalance < 0) availableBalance = 0;
    
    // 获取商户已设置的结算账户
    const [settlements] = await db.query(
      'SELECT * FROM merchant_settlements WHERE merchant_id = ?',
      [user_id]
    );
    
    // 获取待处理的提现金额（仅用于显示，不影响可提现余额计算）
    const [pendingRows] = await db.query(`
      SELECT COALESCE(SUM(amount), 0) as pending 
      FROM settle_records 
      WHERE merchant_id = ? AND status = 0
    `, [user_id]);
    const pendingAmount = parseFloat(pendingRows[0].pending || 0);
    
    res.json({ 
      code: 0, 
      data: {
        balance,
        frozenAmount,
        availableBalance,
        pendingAmount,
        settleRate: parseFloat(options.settle_rate || 0),
        settleFeeMin: parseFloat(options.settle_fee_min || 0),
        settleFeeMax: parseFloat(options.settle_fee_max || 0),
        minSettleAmount: parseFloat(options.min_settle_amount || 10),
        settleCycle: options.settle_cycle,
        settlements
      }
    });
  } catch (error) {
    console.error('获取提现信息错误:', error);
    res.json({ code: -1, msg: '获取失败' });
  }
});

// 申请提现
router.post('/withdraw/apply', requireMerchantRamPermission('finance'), async (req, res) => {
  try {
    const { user_id } = req.user;
    const { amount, settlement_id } = req.body;
    
    if (!amount || !settlement_id) {
      return res.json({ code: -1, msg: '缺少必要参数' });
    }
    
    const applyAmount = parseFloat(amount);
    if (isNaN(applyAmount) || applyAmount <= 0) {
      return res.json({ code: -1, msg: '提现金额无效' });
    }
    
    // 获取结算账户信息
    const [settlementRows] = await db.query(
      'SELECT * FROM merchant_settlements WHERE id = ? AND merchant_id = ?',
      [settlement_id, user_id]
    );
    
    if (settlementRows.length === 0) {
      return res.json({ code: -1, msg: '结算账户不存在' });
    }
    
    const settlement = settlementRows[0];
    
    // 获取余额
    const [pmRows] = await db.query(
      'SELECT balance FROM merchants WHERE user_id = ?',
      [user_id]
    );
    
    if (pmRows.length === 0) {
      return res.json({ code: -1, msg: '商户不存在' });
    }
    
    const balance = parseFloat(pmRows[0].balance || 0);
    
    // 获取结算配置
    const [optRows] = await db.query(
      'SELECT * FROM settlement_options LIMIT 1'
    );
    
    const options = optRows.length > 0 ? optRows[0] : {
      settle_rate: 0,
      settle_fee_min: 0,
      settle_fee_max: 0,
      min_settle_amount: 10,
      settle_cycle: 1
    };
    
    // 检查最低提现金额
    if (applyAmount < parseFloat(options.min_settle_amount || 10)) {
      return res.json({ code: -1, msg: `最低提现金额为 ${options.min_settle_amount} 元` });
    }
    
    // 计算冻结金额（T+1结算模式下，今日收入冻结）
    let frozenAmount = 0;
    if (options.settle_cycle === 1 || options.settle_cycle === 0) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayStart = today.toISOString().slice(0, 19).replace('T', ' ');
      const [orderRows] = await db.query(`
        SELECT COALESCE(SUM(real_money - fee_money), 0) as frozen 
        FROM orders 
        WHERE merchant_id = ? AND status = 1 AND paid_at >= ?
      `, [user_id, todayStart]);
      frozenAmount = parseFloat(orderRows[0].frozen || 0);
    }
    
    // 可提现余额 = 当前余额 - 冻结金额（余额已在申请时扣除，无需计算 pendingAmount）
    const availableBalance = balance - frozenAmount;
    
    if (applyAmount > availableBalance) {
      return res.json({ code: -1, msg: '可提现余额不足' });
    }
    
    // 计算手续费
    let fee = 0;
    const settleRate = parseFloat(options.settle_rate || 0);
    const settleFeeMin = parseFloat(options.settle_fee_min || 0);
    const settleFeeMax = parseFloat(options.settle_fee_max || 0);
    
    if (settleRate > 0) {
      fee = Math.round(applyAmount * settleRate) / 100;
      if (settleFeeMin > 0 && fee < settleFeeMin) fee = settleFeeMin;
      if (settleFeeMax > 0 && fee > settleFeeMax) fee = settleFeeMax;
    }
    
    const realAmount = Math.round((applyAmount - fee) * 100) / 100;
    
    // 生成结算单号
    const settleNo = 'S' + Date.now() + Math.random().toString(36).substring(2, 8).toUpperCase();
    
    // 使用事务：扣除余额 + 创建结算记录 + 记录余额日志
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      
      // 锁定商户记录并获取当前余额
      const [lockedRows] = await conn.query(
        'SELECT balance FROM merchants WHERE user_id = ? FOR UPDATE',
        [user_id]
      );
      const currentBalance = parseFloat(lockedRows[0].balance || 0);
      const newBalance = Math.round((currentBalance - applyAmount) * 100) / 100;
      
      // 扣除余额
      await conn.query(
        'UPDATE merchants SET balance = ? WHERE user_id = ?',
        [newBalance, user_id]
      );
      
      // 记录余额变动日志
      await conn.query(`
        INSERT INTO merchant_balance_logs 
          (merchant_id, type, amount, before_balance, after_balance, related_no, remark)
        VALUES (?, 'withdraw', ?, ?, ?, ?, ?)
      `, [user_id, -applyAmount, currentBalance, newBalance, settleNo, '申请提现']);
      
      // 创建结算记录
      await conn.query(`
        INSERT INTO settle_records 
          (settle_no, merchant_id, settle_type, amount, fee, real_amount,
           account_name, account_no, bank_name, bank_branch, crypto_network, crypto_address, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `, [
        settleNo, user_id, settlement.settle_type, applyAmount, fee, realAmount,
        settlement.account_name, settlement.account_no, settlement.bank_name, settlement.bank_branch,
        settlement.crypto_network, settlement.crypto_address
      ]);
      
      await conn.commit();
    } catch (txError) {
      await conn.rollback();
      throw txError;
    } finally {
      conn.release();
    }

    // 发送 Telegram 通知给管理员（提现申请）
    try {
      // 获取商户名
      const [merchantRows] = await db.query(
        'SELECT username FROM users WHERE id = ?', 
        [user_id]
      );
      const merchantName = merchantRows.length > 0 ? merchantRows[0].username : user_id;
      
      telegramService.notifyAdminWithdrawRequest({
        settle_no: settleNo,
        merchant_name: merchantName,
        merchant_id: user_id,
        amount: applyAmount,
        settle_type: settlement.settle_type,
        account_info: settlement.account_name || settlement.crypto_address || ''
      });
    } catch (tgError) {
      console.error('发送 Telegram 管理员通知失败:', tgError);
    }
    
    res.json({ code: 0, msg: '提现申请已提交', data: { settleNo, amount: applyAmount, fee, realAmount } });
  } catch (error) {
    console.error('申请提现错误:', error);
    res.json({ code: -1, msg: '申请失败' });
  }
});

// 获取结算/提现记录列表
router.get('/withdraw/records', async (req, res) => {
  try {
    const { user_id } = req.user;
    const { status, page = 1, pageSize = 20 } = req.query;
    
    let sql = `
      SELECT * FROM settle_records
      WHERE merchant_id = ?
    `;
    const params = [user_id];
    
    // 修复：检查status是否为有效数字
    if (status !== undefined && status !== '' && !isNaN(parseInt(status))) {
      sql += ' AND status = ?';
      params.push(parseInt(status));
    }
    
    // 统计总数
    const [countResult] = await db.query(sql.replace('*', 'COUNT(*) as total'), params);
    const total = countResult[0].total;
    
    // 分页查询
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(pageSize), (parseInt(page) - 1) * parseInt(pageSize));
    
    const [records] = await db.query(sql, params);
    
    res.json({ code: 0, data: { records, total } });
  } catch (error) {
    console.error('获取结算记录错误:', error);
    res.json({ code: -1, msg: '获取失败' });
  }
});

// 取消提现申请（仅待审核状态）
router.post('/withdraw/cancel', requireMerchantRamPermission('finance'), async (req, res) => {
  try {
    const { user_id } = req.user;
    const { id } = req.body;
    
    // 获取结算记录
    const [records] = await db.query(
      'SELECT * FROM settle_records WHERE id = ? AND merchant_id = ? AND status = 0',
      [id, user_id]
    );
    
    if (records.length === 0) {
      return res.json({ code: -1, msg: '记录不存在或已处理' });
    }
    
    const record = records[0];
    
    // 使用事务：恢复余额 + 更新状态 + 记录日志
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      
      // 锁定商户记录并获取当前余额
      const [lockedRows] = await conn.query(
        'SELECT balance FROM merchants WHERE user_id = ? FOR UPDATE',
        [user_id]
      );
      const currentBalance = parseFloat(lockedRows[0].balance || 0);
      const newBalance = Math.round((currentBalance + parseFloat(record.amount)) * 100) / 100;
      
      // 恢复余额
      await conn.query(
        'UPDATE merchants SET balance = ? WHERE user_id = ?',
        [newBalance, user_id]
      );
      
      // 记录余额变动日志
      await conn.query(`
        INSERT INTO merchant_balance_logs 
          (merchant_id, type, amount, before_balance, after_balance, related_no, remark)
        VALUES (?, 'withdraw_cancel', ?, ?, ?, ?, ?)
      `, [user_id, parseFloat(record.amount), currentBalance, newBalance, record.settle_no, '取消提现']);
      
      // 更新状态
      await conn.query(
        'UPDATE settle_records SET status = 3, remark = ?, processed_at = NOW() WHERE id = ?',
        ['商户取消', id]
      );
      
      await conn.commit();
    } catch (txError) {
      await conn.rollback();
      throw txError;
    } finally {
      conn.release();
    }
    
    res.json({ code: 0, msg: '已取消' });
  } catch (error) {
    console.error('取消提现错误:', error);
    res.json({ code: -1, msg: '操作失败' });
  }
});

module.exports = router;
