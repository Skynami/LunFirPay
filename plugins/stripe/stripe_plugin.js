/**
 * Stripe国际支付插件
 * 移植自PHP版本
 */

const crypto = require('crypto');
const axios = require('axios');

// 插件信息
const info = {
  name: 'stripe',
  showname: 'Stripe',
  author: 'Stripe',
  link: 'https://stripe.com/',
  types: ['alipay', 'wxpay', 'bank', 'paypal'],
  inputs: {
    appid: {
      name: 'API密钥',
      type: 'textarea',
      note: 'sk_live_开头的密钥'
    },
    appkey: {
      name: 'Webhook密钥',
      type: 'textarea',
      note: 'whsec_开头的密钥'
    },
    appswitch: {
      name: '支付模式',
      type: 'select',
      options: { '0': '跳转收银台', '1': '直接支付(仅限支付宝/微信)' }
    },
    currency_code: {
      name: '结算货币',
      type: 'select',
      options: {
        'CNY': '人民币 (CNY)',
        'HKD': '港币 (HKD)',
        'EUR': '欧元 (EUR)',
        'USD': '美元 (USD)',
        'AUD': '澳元 (AUD)',
        'CAD': '加拿大元 (CAD)',
        'GBP': '英镑 (GBP)',
        'BRL': '巴西雷亚尔 (BRL)',
        'CZK': '克朗 (CZK)',
        'DKK': '丹麦克朗(DKK)',
        'HUF': '匈牙利福林 (HUF)',
        'INR': '印度卢比 (INR)',
        'ILS': '以色列新谢克尔 (ILS)',
        'JPY': '日元 (JPY)',
        'MYR': '马来西亚林吉特 (MYR)',
        'MXN': '墨西哥比索 (MXN)',
        'TWD': '新台币 (TWD)',
        'NZD': '新西兰元 (NZD)',
        'NOK': '挪威克朗 (NOK)',
        'PHP': '菲律宾比索 (PHP)',
        'PLN': '波兰兹罗提 (PLN)',
        'RUB': '俄罗斯卢布 (RUB)',
        'SGD': '新加坡元 (SGD)',
        'SEK': '瑞典克朗 (SEK)',
        'CHF': '瑞士法郎 (CHF)',
        'THB': '泰铢 (THB)'
      }
    },
    currency_rate: {
      name: '货币汇率',
      type: 'input',
      note: '例如1元人民币兑换0.137美元(USD)，则此处填0.137'
    }
  },
  select: null,
  note: '需设置WebHook地址：[siteurl]pay/webhook/[channel]/ <br/>侦听的事件，直接支付用: payment_intent.succeeded，跳转收银台用：checkout.session.completed、checkout.session.async_payment_succeeded',
  bindwxmp: false,
  bindwxa: false
};

// Stripe API地址
const STRIPE_API_URL = 'https://api.stripe.com';

/**
 * Stripe API请求
 */
async function stripeRequest(apiKey, method, endpoint, data = null) {
  const url = `${STRIPE_API_URL}${endpoint}`;
  
  const config = {
    method: method.toLowerCase(),
    url: url,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    timeout: 30000
  };

  if (data) {
    config.data = new URLSearchParams(flattenObject(data)).toString();
  }

  const response = await axios(config);
  return response.data;
}

/**
 * 扁平化对象（用于Stripe API参数）
 */
function flattenObject(obj, prefix = '') {
  const result = {};
  
  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}[${key}]` : key;
    
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item === 'object' && item !== null) {
          Object.assign(result, flattenObject(item, `${newKey}[${index}]`));
        } else {
          result[`${newKey}[${index}]`] = item;
        }
      });
    } else if (typeof value === 'object' && value !== null) {
      Object.assign(result, flattenObject(value, newKey));
    } else {
      result[newKey] = value;
    }
  }
  
  return result;
}

/**
 * 验证Webhook签名
 */
function verifyWebhookSignature(payload, signature, secret) {
  const sigParts = signature.split(',').reduce((acc, part) => {
    const [key, value] = part.split('=');
    acc[key] = value;
    return acc;
  }, {});

  const timestamp = sigParts.t;
  const expectedSig = sigParts.v1;

  const signedPayload = `${timestamp}.${payload}`;
  const computedSig = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

  return crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(computedSig));
}

/**
 * 发起支付 - Checkout Session
 */
async function submit(channelConfig, orderInfo) {
  const { trade_no, money, name, return_url, pay_type } = orderInfo;

  // 直接支付模式
  if (channelConfig.appswitch === '1') {
    if (pay_type === 'alipay') {
      return await alipayDirect(channelConfig, orderInfo);
    } else if (pay_type === 'wxpay') {
      return await wxpayDirect(channelConfig, orderInfo);
    }
  }

  const currencyRate = parseFloat(channelConfig.currency_rate) || 1;
  const currencyCode = (channelConfig.currency_code || 'CNY').toLowerCase();
  const amount = Math.round(money * currencyRate * 100);

  // 支付方式映射
  let paymentMethod = '';
  if (pay_type === 'alipay') paymentMethod = 'alipay';
  else if (pay_type === 'wxpay') paymentMethod = 'wechat_pay';
  else if (pay_type === 'paypal') paymentMethod = 'paypal';

  const data = {
    success_url: return_url,
    cancel_url: return_url.replace('/return/', '/cancel/'),
    client_reference_id: trade_no,
    line_items: [{
      price_data: {
        currency: currencyCode,
        product_data: { name: name },
        unit_amount: amount
      },
      quantity: 1
    }],
    mode: 'payment'
  };

  if (paymentMethod) {
    data.payment_method_types = [paymentMethod];
  }

  if (paymentMethod === 'wechat_pay') {
    data.payment_method_options = {
      wechat_pay: { client: 'web' }
    };
  }

  try {
    const result = await stripeRequest(channelConfig.appid, 'POST', '/v1/checkout/sessions', data);
    return {
      type: 'jump',
      url: result.url
    };
  } catch (error) {
    return {
      type: 'error',
      msg: 'Stripe下单失败：' + (error.response?.data?.error?.message || error.message)
    };
  }
}

/**
 * 支付宝直接支付
 */
async function alipayDirect(channelConfig, orderInfo) {
  try {
    const url = await createPaymentIntent(channelConfig, orderInfo, 'alipay');
    return { type: 'jump', url };
  } catch (error) {
    return { type: 'error', msg: '支付宝支付下单失败：' + error.message };
  }
}

/**
 * 微信直接支付
 */
async function wxpayDirect(channelConfig, orderInfo) {
  try {
    const url = await createPaymentIntent(channelConfig, orderInfo, 'wechat_pay');
    return { type: 'qrcode', qr_code: url };
  } catch (error) {
    return { type: 'error', msg: '微信支付下单失败：' + error.message };
  }
}

/**
 * 创建PaymentIntent
 */
async function createPaymentIntent(channelConfig, orderInfo, paymentMethod) {
  const { trade_no, money, name, return_url } = orderInfo;

  const currencyRate = parseFloat(channelConfig.currency_rate) || 1;
  const currencyCode = (channelConfig.currency_code || 'CNY').toLowerCase();
  const amount = Math.round(money * currencyRate * 100);

  // 创建支付方式
  const methodResult = await stripeRequest(channelConfig.appid, 'POST', '/v1/payment_methods', {
    type: paymentMethod
  });
  const paymentMethodId = methodResult.id;

  // 创建PaymentIntent
  const data = {
    amount: amount,
    currency: currencyCode,
    confirm: 'true',
    payment_method: paymentMethodId,
    payment_method_types: [paymentMethod],
    description: name,
    metadata: { order_id: trade_no },
    return_url: return_url
  };

  if (paymentMethod === 'wechat_pay') {
    data.payment_method_options = {
      wechat_pay: { client: 'web' }
    };
  }

  const result = await stripeRequest(channelConfig.appid, 'POST', '/v1/payment_intents', data);

  if (paymentMethod === 'alipay') {
    return result.next_action.alipay_handle_redirect.url;
  } else if (paymentMethod === 'wechat_pay') {
    return result.next_action.wechat_pay_display_qr_code.data;
  } else {
    return result.next_action.redirect_to_url.url;
  }
}

/**
 * Webhook回调处理
 */
async function webhook(channelConfig, payload, headers, order) {
  try {
    const signature = headers['stripe-signature'];
    
    // 验证签名
    if (channelConfig.appkey && signature) {
      const isValid = verifyWebhookSignature(payload, signature, channelConfig.appkey);
      if (!isValid) {
        return { success: false, msg: '签名验证失败' };
      }
    }

    const data = JSON.parse(payload);
    const eventType = data.type;
    const session = data.data.object;

    let outTradeNo = session.client_reference_id || session.metadata?.order_id;
    let apiTradeNo = '';

    switch (eventType) {
      case 'checkout.session.completed':
        if (session.payment_status === 'paid') {
          apiTradeNo = session.payment_intent;
        } else {
          return { success: false };
        }
        break;
      case 'checkout.session.async_payment_succeeded':
        apiTradeNo = session.payment_intent;
        break;
      case 'payment_intent.succeeded':
        apiTradeNo = session.id;
        outTradeNo = session.metadata?.order_id;
        break;
      default:
        return { success: false };
    }

    if (outTradeNo !== order.trade_no) {
      return { success: false, msg: '订单号不匹配' };
    }

    return {
      success: true,
      api_trade_no: apiTradeNo,
      buyer: ''
    };
  } catch (error) {
    console.error('Stripe Webhook处理错误:', error);
    return { success: false, msg: error.message };
  }
}

/**
 * 异步通知（兼容标准接口）
 */
async function notify(channelConfig, notifyData, order) {
  // Stripe使用webhook，此处作为兼容
  return { success: false };
}

/**
 * 同步回调
 */
async function returnCallback(channelConfig, returnData, order) {
  // Stripe同步回调不带支付结果，需要通过webhook确认
  return { success: true, api_trade_no: '', buyer: '' };
}

/**
 * 查询订单
 */
async function query(channelConfig, tradeNo, apiTradeNo = null) {
  try {
    if (apiTradeNo) {
      const result = await stripeRequest(channelConfig.appid, 'GET', `/v1/payment_intents/${apiTradeNo}`);
      return {
        trade_no: result.metadata?.order_id || tradeNo,
        api_trade_no: result.id,
        status: result.status,
        amount: result.amount / 100
      };
    }
    return { trade_no: tradeNo, status: 'UNKNOWN' };
  } catch (error) {
    throw new Error('查询订单失败: ' + error.message);
  }
}

/**
 * 退款
 */
async function refund(channelConfig, refundInfo) {
  const { api_trade_no, refund_money } = refundInfo;

  const currencyRate = parseFloat(channelConfig.currency_rate) || 1;
  const amount = Math.round(refund_money * currencyRate * 100);

  try {
    const result = await stripeRequest(channelConfig.appid, 'POST', '/v1/refunds', {
      payment_intent: api_trade_no,
      amount: amount
    });

    return {
      code: 0,
      trade_no: result.payment_intent,
      refund_fee: result.amount / 100
    };
  } catch (error) {
    return { code: -1, msg: error.response?.data?.error?.message || error.message };
  }
}

/**
 * 获取回调响应
 */
function getNotifyResponse(success) {
  return success ? 'success' : 'fail';
}

module.exports = {
  info,
  submit,
  alipayDirect,
  wxpayDirect,
  webhook,
  notify,
  returnCallback,
  query,
  refund,
  getNotifyResponse
};
