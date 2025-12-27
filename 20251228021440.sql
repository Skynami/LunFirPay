/*
MySQL Backup
Database: lunafir
Backup Time: 2025-12-28 02:14:51
*/

SET FOREIGN_KEY_CHECKS=0;
DROP TABLE IF EXISTS `lunafir`.`channel_groups`;
DROP TABLE IF EXISTS `lunafir`.`merchant_balance_logs`;
DROP TABLE IF EXISTS `lunafir`.`merchant_domains`;
DROP TABLE IF EXISTS `lunafir`.`merchant_settlements`;
DROP TABLE IF EXISTS `lunafir`.`merchants`;
DROP TABLE IF EXISTS `lunafir`.`orders`;
DROP TABLE IF EXISTS `lunafir`.`provider_channels`;
DROP TABLE IF EXISTS `lunafir`.`provider_pay_groups`;
DROP TABLE IF EXISTS `lunafir`.`ram_permissions`;
DROP TABLE IF EXISTS `lunafir`.`sessions`;
DROP TABLE IF EXISTS `lunafir`.`settle_records`;
DROP TABLE IF EXISTS `lunafir`.`settlement_options`;
DROP TABLE IF EXISTS `lunafir`.`system_config`;
DROP TABLE IF EXISTS `lunafir`.`telegram_bind_tokens`;
DROP TABLE IF EXISTS `lunafir`.`telegram_bindings`;
DROP TABLE IF EXISTS `lunafir`.`telegram_pid_settings`;
DROP TABLE IF EXISTS `lunafir`.`user_ram`;
DROP TABLE IF EXISTS `lunafir`.`users`;
DROP TABLE IF EXISTS `lunafir`.`verification_codes`;
CREATE TABLE `channel_groups` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `pay_type_id` int unsigned DEFAULT NULL,
  `name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '轮询组名称',
  `mode` tinyint DEFAULT '0' COMMENT '轮询模式 0=顺序 1=加权随机 2=首个可用',
  `fee_rate` decimal(5,2) DEFAULT NULL,
  `channels` text CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci COMMENT '通道配置JSON [{id,weight}]',
  `current_index` int DEFAULT '0' COMMENT '当前轮询索引',
  `status` tinyint DEFAULT '1' COMMENT '状态',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  KEY `idx_type` (`pay_type_id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='通道轮询组表';
CREATE TABLE `merchant_balance_logs` (
  `id` int NOT NULL AUTO_INCREMENT,
  `merchant_id` varchar(10) NOT NULL,
  `type` enum('income','withdraw','withdraw_reject','refund','refund_reject','adjust') NOT NULL COMMENT '类型: income收入, withdraw提现, withdraw_reject提现拒绝退回, refund退款扣除, refund_reject退款失败退回, adjust人工调整',
  `amount` decimal(12,2) NOT NULL COMMENT '变动金额(正数增加,负数减少)',
  `before_balance` decimal(12,2) NOT NULL COMMENT '变动前余额',
  `after_balance` decimal(12,2) NOT NULL COMMENT '变动后余额',
  `related_no` varchar(64) DEFAULT NULL COMMENT '关联单号(订单号/结算单号)',
  `remark` varchar(255) DEFAULT NULL COMMENT '备注',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_merchant` (`merchant_id`),
  KEY `idx_type` (`type`),
  KEY `idx_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='商户余额变动日志';
CREATE TABLE `merchant_domains` (
  `id` int NOT NULL AUTO_INCREMENT,
  `merchant_id` int NOT NULL,
  `domain` varchar(255) NOT NULL COMMENT '域名，支持泛域名如 *.qq.com',
  `status` enum('pending','approved','rejected') DEFAULT 'pending' COMMENT '审批状态',
  `reviewed_at` datetime DEFAULT NULL COMMENT '审批时间',
  `review_note` varchar(255) DEFAULT NULL COMMENT '审批备注',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_merchant_domain` (`merchant_id`,`domain`),
  KEY `idx_merchant` (`merchant_id`),
  KEY `idx_domain` (`domain`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE `merchant_settlements` (
  `id` int NOT NULL AUTO_INCREMENT,
  `merchant_id` int NOT NULL,
  `settle_type` enum('alipay','wxpay','bank','crypto') CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '结算方式',
  `account_name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '账户名称',
  `account_no` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '账号',
  `bank_name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '银行名称',
  `bank_branch` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '支行名称',
  `crypto_network` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '加密货币网络',
  `crypto_address` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '加密货币地址',
  `is_default` tinyint DEFAULT '0' COMMENT '是否默认',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  KEY `idx_merchant_provider` (`merchant_id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE `merchants` (
  `id` int NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  `user_id` int NOT NULL,
  `pid` varchar(12) DEFAULT NULL,
  `notify_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '默认异步通知地址',
  `return_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '默认同步回调地址',
  `domain` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '网站域名',
  `api_key` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT 'API密钥',
  `rsa_public_key` text,
  `rsa_private_key` text,
  `platform_public_key` text,
  `fee_rate` decimal(10,4) DEFAULT '0.0060',
  `fee_rates` json DEFAULT NULL,
  `fee_payer` enum('merchant','buyer') DEFAULT 'merchant',
  `pay_group_id` int unsigned DEFAULT NULL,
  `balance` decimal(12,2) DEFAULT '0.00',
  `approved_at` datetime DEFAULT NULL,
  `status` enum('pending','active','disabled','banned') DEFAULT 'pending',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_user_id` (`user_id`) USING BTREE,
  UNIQUE KEY `user_id` (`user_id`),
  UNIQUE KEY `pid` (`pid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='商户配置表';
CREATE TABLE `orders` (
  `id` int NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  `trade_no` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '平台交易号',
  `out_trade_no` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '商户订单号',
  `merchant_id` int DEFAULT NULL,
  `channel_id` int DEFAULT NULL COMMENT '通道ID',
  `plugin_name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '支付插件名称',
  `pay_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '支付类型（alipay/wxpay等）',
  `name` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '商品名称',
  `money` decimal(10,2) NOT NULL COMMENT '订单金额',
  `real_money` decimal(10,2) DEFAULT NULL COMMENT '实际支付金额',
  `fee_money` decimal(10,2) DEFAULT '0.00' COMMENT '手续费金额',
  `fee_payer` enum('merchant','buyer') CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT 'merchant' COMMENT '手续费承担方',
  `notify_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '异步通知地址',
  `return_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '同步回调地址',
  `param` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '商户自定义参数',
  `client_ip` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '客户端IP',
  `api_trade_no` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `buyer` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `status` tinyint(1) DEFAULT '0' COMMENT '状态：0未支付 1已支付 2已关闭 3退款中 4已退款',
  `order_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT 'normal',
  `crypto_pid` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `notify_status` tinyint(1) DEFAULT '0' COMMENT '通知状态: 0=未通知, 1=已通知',
  `notify_count` int DEFAULT '0',
  `notify_time` datetime DEFAULT NULL COMMENT '最后通知时间',
  `balance_added` tinyint(1) DEFAULT '0',
  `merchant_confirm` tinyint DEFAULT '0' COMMENT '商户确认: 0=未确认, 1=商户认账',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `paid_at` datetime DEFAULT NULL COMMENT '支付时间',
  `refund_no` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '退款单号',
  `refund_money` decimal(10,2) DEFAULT NULL COMMENT '退款金额',
  `refund_reason` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '退款原因',
  `refund_status` tinyint(1) DEFAULT NULL COMMENT '退款状态：0处理中 1成功 2失败',
  `refund_at` datetime DEFAULT NULL COMMENT '退款时间',
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_trade_no` (`trade_no`) USING BTREE,
  KEY `idx_merchant_id` (`merchant_id`) USING BTREE,
  KEY `idx_out_trade_no` (`out_trade_no`) USING BTREE,
  KEY `idx_status` (`status`) USING BTREE,
  KEY `idx_created_at` (`created_at`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='订单表';
CREATE TABLE `provider_channels` (
  `id` int NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  `channel_id` int DEFAULT '0',
  `channel_name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '通道名称',
  `plugin_name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '插件名称（如alipay）',
  `apptype` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT '' COMMENT '支付接口类型，逗号分隔',
  `pay_type` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT 'all',
  `app_id` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '应用APPID',
  `app_key` text CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci COMMENT '支付宝公钥/应用公钥',
  `app_secret` text CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci COMMENT '应用私钥',
  `app_mch_id` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '商户ID',
  `extra_config` json DEFAULT NULL COMMENT '额外配置（JSON格式）',
  `config` text CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci COMMENT '插件配置JSON',
  `notify_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '自定义异步回调URL',
  `fee_rate` decimal(10,4) DEFAULT '0.0060' COMMENT '费率',
  `cost_rate` decimal(10,4) DEFAULT '0.0000' COMMENT '通道成本（支付给上游）',
  `min_money` decimal(10,2) DEFAULT '0.00' COMMENT '最小金额',
  `max_money` decimal(10,2) DEFAULT '0.00' COMMENT '最大金额，0为无限制',
  `day_limit` decimal(12,2) DEFAULT '0.00' COMMENT '日限额',
  `priority` int DEFAULT '0' COMMENT '优先级',
  `status` tinyint(1) DEFAULT '1' COMMENT '状态：1启用 0禁用',
  `is_deleted` tinyint(1) DEFAULT '0' COMMENT '是否已删除 0否 1是',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='服务商通道配置表';
CREATE TABLE `provider_pay_groups` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '组名称',
  `is_default` tinyint DEFAULT '0' COMMENT '是否默认组',
  `config` text CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci COMMENT '配置JSON {pay_type_id: {channel_mode, channel_id/group_id, rate}}',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  KEY `idx_default` (`is_default`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='服务商支付组配置表';
CREATE TABLE `ram_permissions` (
  `id` int NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  `owner_id` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '所有者用户ID',
  `owner_type` enum('merchant','provider') CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '所有者类型',
  `user_id` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '被授权用户ID',
  `permission_type` enum('admin','order','merchant','channel','settings') CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '权限类型',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (`id`) USING BTREE,
  KEY `idx_owner` (`owner_id`,`owner_type`) USING BTREE,
  KEY `idx_user_id` (`user_id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='RMA权限表';
CREATE TABLE `sessions` (
  `id` int NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  `user_id` int NOT NULL,
  `user_type` enum('merchant','admin','ram') NOT NULL DEFAULT 'merchant',
  `session_token` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '会话令牌',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `expires_at` datetime DEFAULT NULL COMMENT '过期时间（永久登录设为NULL）',
  PRIMARY KEY (`id`) USING BTREE,
  KEY `idx_session_token` (`session_token`) USING BTREE,
  KEY `idx_user_id` (`user_id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='会话表';
CREATE TABLE `settle_records` (
  `id` int NOT NULL AUTO_INCREMENT,
  `settle_no` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  `merchant_id` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  `settle_type` enum('alipay','wxpay','bank','crypto') CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  `amount` decimal(12,2) NOT NULL,
  `fee` decimal(12,2) NOT NULL DEFAULT '0.00',
  `real_amount` decimal(12,2) NOT NULL,
  `account_name` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `account_no` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `bank_name` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `bank_branch` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `crypto_network` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `crypto_address` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `status` tinyint(1) NOT NULL DEFAULT '0',
  `remark` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `processed_at` datetime DEFAULT NULL,
  `processed_by` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_settle_no` (`settle_no`) USING BTREE,
  KEY `idx_merchant_id` (`merchant_id`) USING BTREE,
  KEY `idx_status` (`status`) USING BTREE,
  KEY `idx_created_at` (`created_at`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE `settlement_options` (
  `id` int NOT NULL AUTO_INCREMENT,
  `alipay_enabled` tinyint DEFAULT '1',
  `wxpay_enabled` tinyint DEFAULT '1',
  `bank_enabled` tinyint DEFAULT '1',
  `crypto_enabled` tinyint DEFAULT '0',
  `crypto_networks` json DEFAULT NULL,
  `settle_rate` decimal(5,4) DEFAULT '0.0000',
  `settle_fee_min` decimal(10,2) DEFAULT '0.00',
  `settle_fee_max` decimal(10,2) DEFAULT '0.00',
  `min_settle_amount` decimal(10,2) DEFAULT '10.00',
  `settle_cycle` int DEFAULT '1',
  `auto_settle` tinyint DEFAULT '0',
  `auto_settle_cycle` int DEFAULT '0',
  `auto_settle_amount` decimal(10,2) DEFAULT '0.00',
  `auto_settle_type` varchar(20) DEFAULT '',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE `system_config` (
  `id` int NOT NULL AUTO_INCREMENT,
  `config_key` varchar(50) NOT NULL,
  `config_value` text,
  `description` varchar(255) DEFAULT NULL,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `config_key` (`config_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE `telegram_bind_tokens` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `user_id` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '用户ID',
  `user_type` enum('merchant','provider','ram') CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '用户类型',
  `token` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '绑定Token',
  `expires_at` datetime NOT NULL COMMENT '过期时间',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_token` (`token`) USING BTREE,
  KEY `idx_user` (`user_id`,`user_type`) USING BTREE,
  KEY `idx_expires` (`expires_at`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Telegram绑定Token表';
CREATE TABLE `telegram_bindings` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `user_id` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '用户ID',
  `user_type` enum('merchant','admin','ram') NOT NULL,
  `chat_id` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT 'Telegram Chat ID',
  `telegram_id` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT 'Telegram User ID',
  `username` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT 'Telegram用户名',
  `nickname` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT 'Telegram显示名',
  `notify_payment` tinyint(1) DEFAULT '1' COMMENT '收款通知',
  `notify_balance` tinyint(1) DEFAULT '1' COMMENT '余额变动',
  `notify_settlement` tinyint(1) DEFAULT '1' COMMENT '结算通知',
  `enabled` tinyint(1) DEFAULT '1' COMMENT '是否启用',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_user` (`user_id`,`user_type`) USING BTREE,
  KEY `idx_telegram_id` (`telegram_id`) USING BTREE,
  KEY `idx_chat_id` (`chat_id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Telegram绑定表';
CREATE TABLE `telegram_pid_settings` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `binding_id` int unsigned NOT NULL COMMENT '关联 telegram_bindings.id',
  `pid` varchar(12) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT 'PID',
  `enabled` tinyint(1) DEFAULT '1' COMMENT '是否启用该PID通知',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_binding_pid` (`binding_id`,`pid`) USING BTREE,
  KEY `idx_pid` (`pid`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Telegram PID级别通知设置';
CREATE TABLE `user_ram` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` varchar(13) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT 'RAM用户ID（13位数字）',
  `owner_id` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '所属主账户ID',
  `owner_type` enum('merchant','admin') NOT NULL,
  `display_name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '显示名称',
  `password` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '登录密码',
  `permissions` json DEFAULT NULL COMMENT '权限列表',
  `status` tinyint(1) DEFAULT '1' COMMENT '状态：1启用 0禁用',
  `last_login_at` datetime DEFAULT NULL COMMENT '最后登录时间',
  `last_login_ip` varchar(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '最后登录IP',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `user_id` (`user_id`) USING BTREE,
  KEY `idx_owner` (`owner_id`,`owner_type`) USING BTREE,
  KEY `idx_status` (`status`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='RAM子账户表';
CREATE TABLE `users` (
  `id` int NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  `username` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '用户名',
  `password` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '密码',
  `email` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '邮箱',
  `is_admin` tinyint(1) NOT NULL DEFAULT '0' COMMENT '是否是管理员/服务商',
  `telegram_bindings` json DEFAULT NULL,
  `status` tinyint(1) DEFAULT '1' COMMENT '状态：1启用 0禁用',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_username` (`username`) USING BTREE,
  KEY `idx_email` (`email`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='用户表';
CREATE TABLE `verification_codes` (
  `id` int NOT NULL AUTO_INCREMENT,
  `email` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  `code` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  `type` enum('register','reset') CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  `expires_at` datetime NOT NULL,
  `used` tinyint(1) DEFAULT '0',
  `ip` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  KEY `idx_email_type` (`email`,`type`) USING BTREE,
  KEY `idx_expires` (`expires_at`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
BEGIN;
LOCK TABLES `lunafir`.`channel_groups` WRITE;
DELETE FROM `lunafir`.`channel_groups`;
UNLOCK TABLES;
COMMIT;
BEGIN;
LOCK TABLES `lunafir`.`merchant_balance_logs` WRITE;
DELETE FROM `lunafir`.`merchant_balance_logs`;
UNLOCK TABLES;
COMMIT;
BEGIN;
LOCK TABLES `lunafir`.`merchant_domains` WRITE;
DELETE FROM `lunafir`.`merchant_domains`;
UNLOCK TABLES;
COMMIT;
BEGIN;
LOCK TABLES `lunafir`.`merchant_settlements` WRITE;
DELETE FROM `lunafir`.`merchant_settlements`;
UNLOCK TABLES;
COMMIT;
BEGIN;
LOCK TABLES `lunafir`.`merchants` WRITE;
DELETE FROM `lunafir`.`merchants`;
UNLOCK TABLES;
COMMIT;
BEGIN;
LOCK TABLES `lunafir`.`orders` WRITE;
DELETE FROM `lunafir`.`orders`;
UNLOCK TABLES;
COMMIT;
BEGIN;
LOCK TABLES `lunafir`.`provider_channels` WRITE;
DELETE FROM `lunafir`.`provider_channels`;
UNLOCK TABLES;
COMMIT;
BEGIN;
LOCK TABLES `lunafir`.`provider_pay_groups` WRITE;
DELETE FROM `lunafir`.`provider_pay_groups`;
UNLOCK TABLES;
COMMIT;
BEGIN;
LOCK TABLES `lunafir`.`ram_permissions` WRITE;
DELETE FROM `lunafir`.`ram_permissions`;
UNLOCK TABLES;
COMMIT;
BEGIN;
LOCK TABLES `lunafir`.`sessions` WRITE;
DELETE FROM `lunafir`.`sessions`;
UNLOCK TABLES;
COMMIT;
BEGIN;
LOCK TABLES `lunafir`.`settle_records` WRITE;
DELETE FROM `lunafir`.`settle_records`;
UNLOCK TABLES;
COMMIT;
BEGIN;
LOCK TABLES `lunafir`.`settlement_options` WRITE;
DELETE FROM `lunafir`.`settlement_options`;
UNLOCK TABLES;
COMMIT;
BEGIN;
LOCK TABLES `lunafir`.`system_config` WRITE;
DELETE FROM `lunafir`.`system_config`;
UNLOCK TABLES;
COMMIT;
BEGIN;
LOCK TABLES `lunafir`.`telegram_bind_tokens` WRITE;
DELETE FROM `lunafir`.`telegram_bind_tokens`;
UNLOCK TABLES;
COMMIT;
BEGIN;
LOCK TABLES `lunafir`.`telegram_bindings` WRITE;
DELETE FROM `lunafir`.`telegram_bindings`;
UNLOCK TABLES;
COMMIT;
BEGIN;
LOCK TABLES `lunafir`.`telegram_pid_settings` WRITE;
DELETE FROM `lunafir`.`telegram_pid_settings`;
UNLOCK TABLES;
COMMIT;
BEGIN;
LOCK TABLES `lunafir`.`user_ram` WRITE;
DELETE FROM `lunafir`.`user_ram`;
UNLOCK TABLES;
COMMIT;
BEGIN;
LOCK TABLES `lunafir`.`users` WRITE;
DELETE FROM `lunafir`.`users`;
UNLOCK TABLES;
COMMIT;
BEGIN;
LOCK TABLES `lunafir`.`verification_codes` WRITE;
DELETE FROM `lunafir`.`verification_codes`;
UNLOCK TABLES;
COMMIT;
