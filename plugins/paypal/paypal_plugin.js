/**
 * PayPal国际支付插件
 * 移植自PHP版本
 */

const axios = require('axios');

// 插件信息
const info = {
  name: 'paypal',
  showname: 'PayPal',
  author: 'PayPal',
  link: 'https://www.paypal.com/',
  types: ['paypal'],
  inputs: {
    appid: {
      name: 'ClientId',
      type: 'input',
      note: ''
    },
    appkey: {
      name: 'ClientSecret',
      type: 'input',
      note: ''
    },
    appswitch: {
      name: '模式选择',
      type: 'select',
      options: { '0': '线上模式', '1': '沙盒模式' }
    },
    currency_code: {
      name: '结算货币',
      type: 'select',
      options: {
        'USD': '美元 (USD)',
        'AUD': '澳元 (AUD)',
        'BRL': '巴西雷亚尔 (BRL)',
        'CAD': '加拿大元 (CAD)',
        'CNY': '人民币 (CNY)',
        'CZK': '克朗 (CZK)',
        'DKK': '丹麦克朗(DKK)',
        'EUR': '欧元 (EUR)',
        'HKD': '港币 (HKD)',
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
        'GBP': '英镑 (GBP)',
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
  note: ''
};

// PayPal API地址
const API_URLS = {
  '0': 'https://api-m.paypal.com',
  '1': 'https://api-m.sandbox.paypal.com'
};

/**
 * PayPal客户端类
 */
class PayPalClient {
  constructor(clientId, clientSecret, mode) {
    this.gatewayUrl = API_URLS[mode] || API_URLS['0'];
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.accessToken = null;
  }

  /**
   * 获取Access Token
   */
  async getAccessToken() {
    const url = `${this.gatewayUrl}/v1/oauth2/token`;
    
    const response = await axios.post(url, 'grant_type=client_credentials', {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      auth: {
        username: this.clientId,
        password: this.clientSecret
      },
      timeout: 30000
    });

    this.accessToken = response.data.access_token;
    return this.accessToken;
  }

  /**
   * 发送API请求
   */
  async request(path, data = null, method = 'GET') {
    if (!this.accessToken) {
      await this.getAccessToken();
    }

    const url = `${this.gatewayUrl}${path}`;
    const config = {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.accessToken}`
      },
      timeout: 30000
    };

    let response;
    if (method === 'POST') {
      response = await axios.post(url, data ? JSON.stringify(data) : '', config);
    } else {
      response = await axios.get(url, config);
    }

    return response.data;
  }

  /**
   * 创建订单
   */
  async createOrder(params) {
    return await this.request('/v2/checkout/orders', params, 'POST');
  }

  /**
   * 支付订单
   */
  async captureOrder(orderId) {
    return await this.request(`/v2/checkout/orders/${orderId}/capture`, '', 'POST');
  }

  /**
   * 查询订单
   */
  async orderDetail(orderId) {
    return await this.request(`/v2/checkout/orders/${orderId}`);
  }

  /**
   * 查询支付
   */
  async paymentDetail(captureId) {
    return await this.request(`/v2/payments/captures/${captureId}`);
  }

  /**
   * 退款
   */
  async refundPayment(captureId, params) {
    return await this.request(`/v2/payments/captures/${captureId}/refund`, params, 'POST');
  }

  /**
   * 退款查询
   */
  async refundDetail(refundId) {
    return await this.request(`/v2/payments/refunds/${refundId}`);
  }
}

/**
 * 发起支付
 */
async function submit(channelConfig, orderInfo) {
  const { trade_no, money, name, return_url } = orderInfo;

  const currencyRate = parseFloat(channelConfig.currency_rate) || 1;
  const currencyCode = channelConfig.currency_code || 'USD';
  const convertedMoney = (money * currencyRate).toFixed(2);

  const params = {
    intent: 'CAPTURE',
    purchase_units: [{
      amount: {
        currency_code: currencyCode,
        value: convertedMoney
      },
      description: name,
      custom_id: trade_no,
      invoice_id: trade_no
    }],
    application_context: {
      cancel_url: return_url.replace('/return/', '/cancel/'),
      return_url: return_url
    }
  };

  try {
    const client = new PayPalClient(channelConfig.appid, channelConfig.appkey, channelConfig.appswitch);
    const result = await client.createOrder(params);

    let approvalUrl = null;
    for (const link of result.links) {
      if (link.rel === 'approve') {
        approvalUrl = link.href;
        break;
      }
    }

    if (!approvalUrl) {
      throw new Error('获取支付链接失败');
    }

    return {
      type: 'jump',
      url: approvalUrl
    };
  } catch (error) {
    return {
      type: 'error',
      msg: 'PayPal下单失败：' + error.message
    };
  }
}

/**
 * 同步回调处理
 */
async function returnCallback(channelConfig, returnData, order) {
  const { token, PayerID } = returnData;

  if (!token || !PayerID) {
    return { success: false, msg: 'PayPal返回参数错误' };
  }

  try {
    const client = new PayPalClient(channelConfig.appid, channelConfig.appkey, channelConfig.appswitch);
    const result = await client.captureOrder(token);

    const captures = result.purchase_units[0].payments.captures[0];
    const amount = captures.seller_receivable_breakdown.gross_amount.value;
    const apiTradeNo = captures.id;
    const outTradeNo = captures.invoice_id;
    const buyer = result.payer.email_address;

    if (outTradeNo !== order.trade_no) {
      return { success: false, msg: '订单信息校验失败' };
    }

    return {
      success: true,
      api_trade_no: apiTradeNo,
      buyer: buyer
    };
  } catch (error) {
    return { success: false, msg: '支付订单失败 ' + error.message };
  }
}

/**
 * 异步回调验证 (Webhook)
 */
async function notify(channelConfig, notifyData, order) {
  try {
    // PayPal使用webhook，这里简化处理
    if (!notifyData || !notifyData.event_type) {
      return { success: false };
    }

    // 只处理支付完成事件
    if (notifyData.event_type !== 'PAYMENT.CAPTURE.COMPLETED') {
      return { success: false };
    }

    const resource = notifyData.resource;
    const apiTradeNo = resource.id;
    const outTradeNo = resource.invoice_id;

    if (outTradeNo !== order.trade_no) {
      return { success: false };
    }

    return {
      success: true,
      api_trade_no: apiTradeNo,
      buyer: ''
    };
  } catch (error) {
    console.error('PayPal回调处理错误:', error);
    return { success: false };
  }
}

/**
 * 查询订单
 */
async function query(channelConfig, tradeNo, apiTradeNo = null) {
  try {
    const client = new PayPalClient(channelConfig.appid, channelConfig.appkey, channelConfig.appswitch);
    
    if (apiTradeNo) {
      const result = await client.paymentDetail(apiTradeNo);
      return {
        trade_no: result.invoice_id,
        api_trade_no: result.id,
        status: result.status,
        amount: result.amount.value
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
  const currencyCode = channelConfig.currency_code || 'USD';
  const convertedMoney = (refund_money * currencyRate).toFixed(2);

  const params = {
    amount: {
      currency_code: currencyCode,
      value: convertedMoney
    }
  };

  try {
    const client = new PayPalClient(channelConfig.appid, channelConfig.appkey, channelConfig.appswitch);
    const result = await client.refundPayment(api_trade_no, params);
    
    return {
      code: 0,
      trade_no: result.id,
      refund_fee: result.amount.value
    };
  } catch (error) {
    return { code: -1, msg: error.message };
  }
}

/**
 * 取消支付回调
 */
async function cancel(channelConfig, data, order) {
  return { type: 'error', msg: '支付已取消' };
}

/**
 * 获取回调响应
 */
function getNotifyResponse(success) {
  return success ? 'OK' : 'FAIL';
}

module.exports = {
  info,
  submit,
  returnCallback,
  notify,
  query,
  refund,
  cancel,
  getNotifyResponse
};
