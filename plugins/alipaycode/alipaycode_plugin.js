/**
 * 支付宝免签约码支付插件
 * 移植自PHP版本
 */

const crypto = require('crypto');
const axios = require('axios');

// 插件信息
const info = {
    name: 'alipaycode',
    showname: '支付宝免签约码支付',
    author: '支付宝',
    link: 'https://open.alipay.com/',
    types: ['alipay'],
    inputs: {
        appid: {
            name: '应用APPID',
            type: 'input',
            note: ''
        },
        appkey: {
            name: '支付宝公钥',
            type: 'textarea',
            note: '填错也可以支付成功但会无法回调，如果用公钥证书模式此处留空'
        },
        appsecret: {
            name: '应用私钥',
            type: 'textarea',
            note: ''
        },
        appmchid: {
            name: '支付宝UID',
            type: 'input',
            note: '2088开头的16位纯数字'
        },
        apptoken: {
            name: '商户授权token',
            type: 'input',
            note: '只有第三方应用需要填写，非第三方应用必须留空'
        },
        appswitch: {
            name: '支付类型',
            type: 'select',
            options: { '0': '普通转账', '1': '转账确认单' }
        }
    },
    certs: [
        { key: 'appCert', name: '应用公钥证书', ext: '.crt', desc: 'appCertPublicKey_应用APPID.crt', optional: true },
        { key: 'alipayCert', name: '支付宝公钥证书', ext: '.crt', desc: 'alipayCertPublicKey_RSA2.crt', optional: true },
        { key: 'alipayRootCert', name: '支付宝根证书', ext: '.crt', desc: 'alipayRootCert.crt', optional: true }
    ],
    note: '<p>可不签约支付产品，支付宝开放平台应用需要已上线，不能开启余额宝自动转入。如果是第三方应用类型，还需要填写商户授权token。</p><p>【可选】如果使用公钥证书模式，请上传3个证书文件</p><p>需添加守护进程，运行目录：<u>[basedir]plugins/alipaycode/</u> 启动命令：<u>node server.js [channel]</u> </p>',
    bindwxmp: false,
    bindwxa: false
};

/**
 * 发起支付 - 跳转到二维码页面
 */
async function submit(channelConfig, orderInfo) {
    const { trade_no } = orderInfo;
    return {
        type: 'jump',
        url: `/pay/qrcode/${trade_no}/`
    };
}

/**
 * MAPI支付
 */
async function mapi(channelConfig, orderInfo) {
    const { trade_no } = orderInfo;
    return {
        type: 'jump',
        url: `/pay/qrcode/${trade_no}/`
    };
}

/**
 * 扫码支付
 */
async function qrcode(channelConfig, orderInfo, conf) {
    const { trade_no } = orderInfo;
    const siteurl = conf.siteurl || '';
    
    let code_url = `${siteurl}pay/pay/${trade_no}/`;
    
    if (conf.alipay_qrcode_url) {
        code_url = `${conf.alipay_qrcode_url}pay/pay/${trade_no}/`;
    }
    
    return {
        type: 'qrcode',
        page: 'alipay_qrcode',
        url: code_url
    };
}

/**
 * 支付页面
 */
async function pay(channelConfig, orderInfo, conf) {
    const { trade_no, real_money } = orderInfo;
    
    // 转账确认单模式
    if (channelConfig.appswitch === '1') {
        const params = {
            productCode: 'TRANSFER_TO_ALIPAY_ACCOUNT',
            bizScene: 'YUEBAO',
            transAmount: real_money,
            remark: trade_no,
            businessParams: {
                returnUrl: 'alipays://platformapi/startapp?appId=2021001167654035&nbupdate=syncforce'
            },
            payeeInfo: {
                identity: channelConfig.appmchid,
                identityType: 'ALIPAY_USER_ID'
            }
        };
        const url = `https://render.alipay.com/p/yuyan/180020010001206672/rent-index.html?formData=${encodeURIComponent(JSON.stringify(params))}`;
        return {
            type: 'jump',
            url: url
        };
    }
    
    // 普通转账页面
    return {
        type: 'page',
        page: 'alipaycode_pay'
    };
}

module.exports = {
    info,
    submit,
    mapi,
    qrcode,
    pay
};
