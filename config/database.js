const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// 加载配置（必须存在 config.yaml）
const configPath = path.join(__dirname, '..', 'config.yaml');
if (!fs.existsSync(configPath)) {
  throw new Error('[Database] 配置文件 config.yaml 不存在，请创建配置文件');
}
const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
const dbConfigYaml = config.database || {};

// 数据库配置
const dbConfig = {
  host: dbConfigYaml.host,
  port: dbConfigYaml.port,
  user: dbConfigYaml.user,
  password: dbConfigYaml.password,
  database: dbConfigYaml.database,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: dbConfigYaml.timezone || '+08:00'
};

// 创建连接池，添加更多配置以处理连接问题
const pool = mysql.createPool({
  ...dbConfig,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  maxIdle: 10,
  idleTimeout: 60000,
  connectTimeout: 10000
});

// 测试连接
pool.getConnection()
  .then(connection => {
    console.log('数据库连接成功');
    connection.release();
  })
  .catch(err => {
    console.error('数据库连接失败:', err.message);
  });

// 处理连接错误
pool.on('error', (err) => {
  console.error('数据库连接池错误:', err.message);
  if (err.code === 'ECONNRESET' || err.code === 'PROTOCOL_CONNECTION_LOST') {
    console.log('尝试重新建立数据库连接...');
  }
});

// 带重试的查询函数
async function queryWithRetry(sql, params, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await pool.query(sql, params);
    } catch (err) {
      if ((err.code === 'ECONNRESET' || err.code === 'PROTOCOL_CONNECTION_LOST') && i < retries - 1) {
        console.log(`数据库查询失败，正在重试 (${i + 1}/${retries})...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
}

// 扩展pool对象
pool.queryWithRetry = queryWithRetry;

// 导出连接池和配置
module.exports = pool;
module.exports.config = dbConfig;
