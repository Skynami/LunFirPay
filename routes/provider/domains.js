/**
 * Provider 域名白名单管理路由
 */
const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const { requireProviderRamPermission } = require('../auth');

// 获取所有域名列表（支持筛选状态）
router.get('/domains', requireProviderRamPermission('merchant'), async (req, res) => {
  try {
    const { status, merchant_id, page = 1, pageSize = 20 } = req.query;
    
    let whereClause = ' WHERE 1=1';
    const params = [];
    
    if (status) {
      whereClause += ' AND d.status = ?';
      params.push(status);
    }
    
    if (merchant_id) {
      whereClause += ' AND d.merchant_id = ?';
      params.push(merchant_id);
    }
    
    const fromClause = `
      FROM merchant_domains d
      LEFT JOIN merchants m ON d.merchant_id = m.user_id
      LEFT JOIN users u ON d.merchant_id = u.id
    `;
    
    // 统计总数
    const countSql = `SELECT COUNT(*) as total ${fromClause} ${whereClause}`;
    const [countResult] = await db.query(countSql, params);
    const total = countResult[0].total;
    
    // 分页查询
    const offset = (parseInt(page) - 1) * parseInt(pageSize);
    const sql = `
      SELECT d.id, d.merchant_id, d.domain, d.status, d.review_note, d.created_at, d.reviewed_at,
             u.username
      ${fromClause} ${whereClause}
      ORDER BY d.created_at DESC LIMIT ? OFFSET ?
    `;
    const queryParams = [...params, parseInt(pageSize), offset];
    
    const [domains] = await db.query(sql, queryParams);
    
    res.json({
      code: 0,
      data: {
        list: domains,
        total,
        page: parseInt(page),
        pageSize: parseInt(pageSize)
      }
    });
  } catch (error) {
    console.error('获取域名列表失败:', error);
    res.json({ code: -1, msg: '获取域名列表失败' });
  }
});

// 审核通过域名
router.post('/domains/approve', requireProviderRamPermission('merchant'), async (req, res) => {
  try {
    const { id, note } = req.body;
    
    if (!id) {
      return res.json({ code: -1, msg: '缺少域名ID' });
    }
    
    // 检查域名是否存在
    const [domains] = await db.query(
      'SELECT id, domain, merchant_id, status FROM merchant_domains WHERE id = ?',
      [id]
    );
    
    if (domains.length === 0) {
      return res.json({ code: -1, msg: '域名不存在' });
    }
    
    if (domains[0].status === 'approved') {
      return res.json({ code: -1, msg: '该域名已通过审核' });
    }
    
    // 检查该域名是否被其他商户已审核通过
    const [otherApproved] = await db.query(
      'SELECT id FROM merchant_domains WHERE domain = ? AND merchant_id != ? AND status = ?',
      [domains[0].domain, domains[0].merchant_id, 'approved']
    );
    
    if (otherApproved.length > 0) {
      return res.json({ code: -1, msg: '该域名已被其他商户绑定，无法审核通过' });
    }
    
    await db.query(
      'UPDATE merchant_domains SET status = ?, review_note = ?, reviewed_at = NOW() WHERE id = ?',
      ['approved', note || null, id]
    );
    
    res.json({ code: 0, msg: '审核通过' });
  } catch (error) {
    console.error('审核域名失败:', error);
    res.json({ code: -1, msg: '审核失败' });
  }
});

// 审核拒绝域名
router.post('/domains/reject', requireProviderRamPermission('merchant'), async (req, res) => {
  try {
    const { id, note } = req.body;
    
    if (!id) {
      return res.json({ code: -1, msg: '缺少域名ID' });
    }
    
    if (!note) {
      return res.json({ code: -1, msg: '请输入拒绝原因' });
    }
    
    // 检查域名是否存在
    const [domains] = await db.query(
      'SELECT id, status FROM merchant_domains WHERE id = ?',
      [id]
    );
    
    if (domains.length === 0) {
      return res.json({ code: -1, msg: '域名不存在' });
    }
    
    if (domains[0].status === 'rejected') {
      return res.json({ code: -1, msg: '该域名已被拒绝' });
    }
    
    await db.query(
      'UPDATE merchant_domains SET status = ?, review_note = ?, reviewed_at = NOW() WHERE id = ?',
      ['rejected', note, id]
    );
    
    res.json({ code: 0, msg: '已拒绝' });
  } catch (error) {
    console.error('拒绝域名失败:', error);
    res.json({ code: -1, msg: '拒绝失败' });
  }
});

// 删除域名记录（管理员可删除任何状态）
router.post('/domains/delete', requireProviderRamPermission('merchant'), async (req, res) => {
  try {
    const { id } = req.body;
    
    if (!id) {
      return res.json({ code: -1, msg: '缺少域名ID' });
    }
    
    const [result] = await db.query('DELETE FROM merchant_domains WHERE id = ?', [id]);
    
    if (result.affectedRows === 0) {
      return res.json({ code: -1, msg: '域名不存在' });
    }
    
    res.json({ code: 0, msg: '域名已删除' });
  } catch (error) {
    console.error('删除域名失败:', error);
    res.json({ code: -1, msg: '删除失败' });
  }
});

module.exports = router;
