/**
 * Provider 结算配置 + 提现审核路由
 */
const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const { requireProviderRamPermission } = require('../auth');

// ==================== 结算管理接口 ====================

// 获取结算选项设置
router.get('/settlement/options', async (req, res) => {
  try {
    const [options] = await db.query(
      "SELECT * FROM settlement_options LIMIT 1"
    );
    
    if (options.length === 0) {
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

// 保存结算选项设置
router.post('/settlement/options', requireProviderRamPermission('settings'), async (req, res) => {
  try {
    const { alipay_enabled, wxpay_enabled, bank_enabled, crypto_enabled, crypto_networks } = req.body;
    
    const [existing] = await db.query(
      "SELECT id FROM settlement_options LIMIT 1"
    );
    
    const networksJson = crypto_networks ? JSON.stringify(crypto_networks) : null;
    
    if (existing.length > 0) {
      await db.query(`
        UPDATE settlement_options SET 
          alipay_enabled = ?, wxpay_enabled = ?, bank_enabled = ?, 
          crypto_enabled = ?, crypto_networks = ?
        WHERE id = ?
      `, [alipay_enabled ? 1 : 0, wxpay_enabled ? 1 : 0, bank_enabled ? 1 : 0, crypto_enabled ? 1 : 0, networksJson, existing[0].id]);
    } else {
      await db.query(`
        INSERT INTO settlement_options 
          (alipay_enabled, wxpay_enabled, bank_enabled, crypto_enabled, crypto_networks)
        VALUES (?, ?, ?, ?, ?)
      `, [alipay_enabled ? 1 : 0, wxpay_enabled ? 1 : 0, bank_enabled ? 1 : 0, crypto_enabled ? 1 : 0, networksJson]);
    }
    
    res.json({ code: 0, msg: '保存成功' });
  } catch (error) {
    console.error('保存结算选项错误:', error);
    res.json({ code: -1, msg: '保存失败' });
  }
});

// 获取商户结算信息列表
router.get('/settlement/merchants', async (req, res) => {
  try {
    // 单服务商模式，排除管理员
    const [merchants] = await db.query(`
      SELECT m.*, u.username, u.email,
        (SELECT JSON_ARRAYAGG(JSON_OBJECT(
          'id', ms.id, 'settle_type', ms.settle_type, 'account_name', ms.account_name,
          'account_no', ms.account_no, 'bank_name', ms.bank_name, 'crypto_network', ms.crypto_network,
          'crypto_address', ms.crypto_address, 'is_default', ms.is_default
        )) FROM merchant_settlements ms WHERE ms.merchant_id = m.user_id) as settlements
      FROM merchants m
      LEFT JOIN users u ON m.user_id = u.id
      WHERE u.is_admin = 0
      ORDER BY m.id DESC
    `);
    
    // 解析 settlements JSON（可能已经是对象或需要解析的字符串）
    merchants.forEach(m => {
      if (m.settlements) {
        m.settlements = typeof m.settlements === 'string' ? JSON.parse(m.settlements) : m.settlements;
      } else {
        m.settlements = [];
      }
    });
    
    res.json({ code: 0, data: merchants });
  } catch (error) {
    console.error('获取商户结算信息错误:', error);
    res.json({ code: -1, msg: '获取失败' });
  }
});

// 管理员保存商户结算设置
router.post('/settlement/merchant/save', requireProviderRamPermission('merchant'), async (req, res) => {
  try {
    const { merchant_id, settle_type, account_name, account_no, bank_name, bank_branch, crypto_network, crypto_address, is_default } = req.body;
    
    if (!merchant_id || !settle_type) {
      return res.json({ code: -1, msg: '缺少必要参数' });
    }
    
    // 验证商户是否存在
    const [merchants] = await db.query(
      'SELECT id FROM merchants WHERE user_id = ?',
      [merchant_id]
    );
    
    if (merchants.length === 0) {
      return res.json({ code: -1, msg: '商户不存在' });
    }
    
    // 如果设为默认，先取消其他默认
    if (is_default) {
      await db.query(
        'UPDATE merchant_settlements SET is_default = 0 WHERE merchant_id = ?',
        [merchant_id]
      );
    }
    
    // 检查是否已存在相同类型的设置
    const [existing] = await db.query(
      'SELECT id FROM merchant_settlements WHERE merchant_id = ? AND settle_type = ?',
      [merchant_id, settle_type]
    );
    
    if (existing.length > 0) {
      // 更新
      await db.query(`
        UPDATE merchant_settlements SET 
          account_name = ?, account_no = ?, bank_name = ?, bank_branch = ?,
          crypto_network = ?, crypto_address = ?, is_default = ?
        WHERE id = ?
      `, [account_name, account_no, bank_name, bank_branch, crypto_network, crypto_address, is_default ? 1 : 0, existing[0].id]);
    } else {
      // 新增
      await db.query(`
        INSERT INTO merchant_settlements 
          (merchant_id, settle_type, account_name, account_no, bank_name, bank_branch, crypto_network, crypto_address, is_default)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [merchant_id, settle_type, account_name, account_no, bank_name, bank_branch, crypto_network, crypto_address, is_default ? 1 : 0]);
    }
    
    res.json({ code: 0, msg: '保存成功' });
  } catch (error) {
    console.error('保存商户结算设置错误:', error);
    res.json({ code: -1, msg: '保存失败' });
  }
});

// 管理员删除商户结算设置
router.post('/settlement/merchant/delete', requireProviderRamPermission('merchant'), async (req, res) => {
  try {
    const { id, merchant_id } = req.body;
    
    if (!id || !merchant_id) {
      return res.json({ code: -1, msg: '缺少必要参数' });
    }
    
    await db.query(
      'DELETE FROM merchant_settlements WHERE id = ? AND merchant_id = ?',
      [id, merchant_id]
    );
    
    res.json({ code: 0, msg: '删除成功' });
  } catch (error) {
    console.error('删除商户结算设置错误:', error);
    res.json({ code: -1, msg: '删除失败' });
  }
});

// ===================== 提现审核功能 =====================

// 保存结算费率配置
router.post('/settlement/fee-config', requireProviderRamPermission('settings'), async (req, res) => {
  try {
    const { settle_rate, settle_fee_min, settle_fee_max, min_settle_amount, settle_cycle, auto_settle, auto_settle_cycle, auto_settle_amount, auto_settle_type } = req.body;
    
    const [existing] = await db.query(
      "SELECT id FROM settlement_options LIMIT 1"
    );
    
    if (existing.length > 0) {
      await db.query(`
        UPDATE settlement_options SET 
          settle_rate = ?, settle_fee_min = ?, settle_fee_max = ?, 
          min_settle_amount = ?, settle_cycle = ?, auto_settle = ?, 
          auto_settle_cycle = ?, auto_settle_amount = ?, auto_settle_type = ?
        WHERE id = ?
      `, [settle_rate || 0, settle_fee_min || 0, settle_fee_max || 0, min_settle_amount || 10, settle_cycle ?? 1, auto_settle ? 1 : 0, auto_settle_cycle ?? 0, auto_settle_amount || 0, auto_settle_type || '', existing[0].id]);
    } else {
      await db.query(`
        INSERT INTO settlement_options 
          (settle_rate, settle_fee_min, settle_fee_max, min_settle_amount, settle_cycle, auto_settle, auto_settle_cycle, auto_settle_amount, auto_settle_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [settle_rate || 0, settle_fee_min || 0, settle_fee_max || 0, min_settle_amount || 10, settle_cycle ?? 1, auto_settle ? 1 : 0, auto_settle_cycle ?? 0, auto_settle_amount || 0, auto_settle_type || '']);
    }
    
    res.json({ code: 0, msg: '保存成功' });
  } catch (error) {
    console.error('保存结算费率配置错误:', error);
    res.json({ code: -1, msg: '保存失败' });
  }
});

// 获取提现申请列表
router.get('/withdraw/records', async (req, res) => {
  try {
    const { merchant_id, status, settle_type, page = 1, pageSize = 20 } = req.query;
    
    // 单服务商模式，不按 provider_id 过滤
    let sql = `
      SELECT sr.*, u.username as merchant_name 
      FROM settle_records sr
      LEFT JOIN users u ON sr.merchant_id = u.id
      WHERE 1=1
    `;
    const params = [];
    
    if (merchant_id) {
      sql += ' AND sr.merchant_id = ?';
      params.push(merchant_id);
    }
    
    if (status !== undefined && status !== '') {
      sql += ' AND sr.status = ?';
      params.push(parseInt(status));
    }
    
    if (settle_type) {
      sql += ' AND sr.settle_type = ?';
      params.push(settle_type);
    }
    
    // 统计总数
    const [countResult] = await db.query(sql.replace('sr.*, u.username as merchant_name', 'COUNT(*) as total'), params);
    const total = countResult[0].total;
    
    // 分页查询
    sql += ' ORDER BY sr.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(pageSize), (parseInt(page) - 1) * parseInt(pageSize));
    
    const [records] = await db.query(sql, params);
    
    // 统计待处理数量和金额（单服务商模式，不按 provider_id 过滤）
    const [pendingStats] = await db.query(`
      SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total_amount
      FROM settle_records WHERE status = 0
    `);
    
    res.json({ 
      code: 0, 
      data: { 
        records, 
        total, 
        pendingCount: pendingStats[0].count,
        pendingAmount: parseFloat(pendingStats[0].total_amount || 0)
      } 
    });
  } catch (error) {
    console.error('获取提现申请列表错误:', error);
    res.json({ code: -1, msg: '获取失败' });
  }
});

// 审核通过提现申请
router.post('/withdraw/approve', requireProviderRamPermission('finance'), async (req, res) => {
  try {
    const { user_id } = req.user;
    const { id, remark } = req.body;
    
    // 单服务商模式，不按 provider_id 过滤
    const [records] = await db.query(
      'SELECT * FROM settle_records WHERE id = ?',
      [id]
    );
    
    if (records.length === 0) {
      return res.json({ code: -1, msg: '记录不存在' });
    }
    
    const record = records[0];
    
    if (record.status !== 0) {
      return res.json({ code: -1, msg: '该申请已处理' });
    }
    
    // 更新记录状态（余额已在申请时扣除，这里只更新状态）
    await db.query(
      'UPDATE settle_records SET status = 1, remark = ?, processed_at = NOW(), processed_by = ? WHERE id = ?',
      [remark || '审核通过', user_id, id]
    );
    
    res.json({ code: 0, msg: '已审核通过' });
  } catch (error) {
    console.error('审核通过错误:', error);
    res.json({ code: -1, msg: '操作失败' });
  }
});

// 拒绝提现申请
router.post('/withdraw/reject', requireProviderRamPermission('finance'), async (req, res) => {
  try {
    const { user_id } = req.user;
    const { id, remark } = req.body;
    
    if (!remark) {
      return res.json({ code: -1, msg: '请填写拒绝原因' });
    }
    
    // 使用事务处理
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      
      // 锁定结算记录
      const [records] = await conn.query(
        'SELECT * FROM settle_records WHERE id = ? FOR UPDATE',
        [id]
      );
      
      if (records.length === 0) {
        await conn.rollback();
        return res.json({ code: -1, msg: '记录不存在' });
      }
      
      if (records[0].status !== 0) {
        await conn.rollback();
        return res.json({ code: -1, msg: '该申请已处理' });
      }
      
      const record = records[0];
      const merchantId = record.merchant_id;
      const refundAmount = parseFloat(record.amount);
      
      // 锁定商户记录并获取当前余额
      const [merchantRows] = await conn.query(
        'SELECT balance FROM merchants WHERE user_id = ? FOR UPDATE',
        [merchantId]
      );
      
      if (merchantRows.length === 0) {
        await conn.rollback();
        return res.json({ code: -1, msg: '商户不存在' });
      }
      
      const currentBalance = parseFloat(merchantRows[0].balance || 0);
      const newBalance = Math.round((currentBalance + refundAmount) * 100) / 100;
      
      // 恢复余额
      await conn.query(
        'UPDATE merchants SET balance = ? WHERE user_id = ?',
        [newBalance, merchantId]
      );
      
      // 记录余额变动日志
      await conn.query(`
        INSERT INTO merchant_balance_logs 
          (merchant_id, type, amount, before_balance, after_balance, related_no, remark)
        VALUES (?, 'withdraw_reject', ?, ?, ?, ?, ?)
      `, [merchantId, refundAmount, currentBalance, newBalance, record.settle_no, `提现拒绝退回: ${remark}`]);
      
      // 更新记录状态
      await conn.query(
        'UPDATE settle_records SET status = 3, remark = ?, processed_at = NOW(), processed_by = ? WHERE id = ?',
        [remark, user_id, id]
      );
      
      await conn.commit();
      res.json({ code: 0, msg: '已拒绝，余额已退回' });
    } catch (txError) {
      await conn.rollback();
      throw txError;
    } finally {
      conn.release();
    }
  } catch (error) {
    console.error('拒绝提现错误:', error);
    res.json({ code: -1, msg: '操作失败' });
  }
});

// 批量审核通过
router.post('/withdraw/batch-approve', requireProviderRamPermission('finance'), async (req, res) => {
  try {
    const { user_id } = req.user;
    const { ids } = req.body;
    
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.json({ code: -1, msg: '请选择要审核的记录' });
    }
    
    let successCount = 0;
    let failCount = 0;
    
    for (const id of ids) {
      try {
        // 检查记录状态
        const [records] = await db.query(
          'SELECT * FROM settle_records WHERE id = ? AND status = 0',
          [id]
        );
        
        if (records.length === 0) {
          failCount++;
          continue;
        }
        
        // 更新状态（余额已在申请时扣除，这里只更新状态）
        await db.query(
          'UPDATE settle_records SET status = 1, remark = ?, processed_at = NOW(), processed_by = ? WHERE id = ?',
          ['批量审核通过', user_id, id]
        );
        
        successCount++;
      } catch (err) {
        console.error(`批量审核错误 id=${id}:`, err);
        failCount++;
      }
    }
    
    res.json({ code: 0, msg: `成功 ${successCount} 条，失败 ${failCount} 条` });
  } catch (error) {
    console.error('批量审核错误:', error);
    res.json({ code: -1, msg: '操作失败' });
  }
});

module.exports = router;
