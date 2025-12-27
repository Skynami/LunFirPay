/**
 * Provider 系统配置路由
 */
const express = require('express');
const router = express.Router();
const systemConfig = require('../../utils/systemConfig');
const { requireProviderRamPermission } = require('../auth');

// 获取系统配置（支付设置相关）
router.get('/system/config', requireProviderRamPermission('settings'), async (req, res) => {
  try {
    const allConfig = await systemConfig.getAllConfig();
    
    // 只返回需要的配置项
    const paymentConfig = {
      order_name_template: allConfig.order_name_template || '',
      page_order_name: allConfig.page_order_name || '0',
      notify_order_name: allConfig.notify_order_name || '0',
      site_name: allConfig.site_name || '支付平台',
      api_endpoint: allConfig.api_endpoint || '',
      domain_whitelist_enabled: allConfig.domain_whitelist_enabled || '0',
      user_refund: allConfig.user_refund || '0'
    };
    
    res.json({ code: 0, data: paymentConfig });
  } catch (error) {
    console.error('获取系统配置失败:', error);
    res.json({ code: -1, msg: '获取系统配置失败' });
  }
});

// 更新系统配置
router.post('/system/config', requireProviderRamPermission('settings'), async (req, res) => {
  try {
    const { order_name_template, page_order_name, notify_order_name, site_name, api_endpoint, domain_whitelist_enabled, user_refund } = req.body;
    
    // 更新配置
    if (order_name_template !== undefined) {
      await systemConfig.setConfig('order_name_template', order_name_template, '订单名称模板');
    }
    if (page_order_name !== undefined) {
      await systemConfig.setConfig('page_order_name', page_order_name, '收银台隐藏商品名');
    }
    if (notify_order_name !== undefined) {
      await systemConfig.setConfig('notify_order_name', notify_order_name, '回调通知隐藏商品名');
    }
    if (site_name !== undefined) {
      await systemConfig.setConfig('site_name', site_name, '站点名称');
    }
    if (api_endpoint !== undefined) {
      await systemConfig.setConfig('api_endpoint', api_endpoint, 'API端点地址');
    }
    if (domain_whitelist_enabled !== undefined) {
      await systemConfig.setConfig('domain_whitelist_enabled', domain_whitelist_enabled, '启用域名白名单验证');
    }
    if (user_refund !== undefined) {
      await systemConfig.setConfig('user_refund', user_refund, '商户自助退款(0=关闭,1=开启)');
    }
    
    res.json({ code: 0, msg: '保存成功' });
  } catch (error) {
    console.error('保存系统配置失败:', error);
    res.json({ code: -1, msg: '保存系统配置失败' });
  }
});

module.exports = router;
