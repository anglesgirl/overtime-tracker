# 加班打卡系统

基于 Cloudflare Workers + D1 的多人加班打卡小程序，自动计算加班时长和加班费，支持调休管理。

## 功能

- **多人注册登录**：每个用户独立账号，各自配置工资和上下班时间
- **加班打卡**：输入下班时间，自动计算加班时长和加班费
- **加班费计算**：按劳动法标准
  - 工作日加班：1.5 倍时薪
  - 休息日加班：2 倍时薪
  - 法定节假日加班：3 倍时薪
  - 时薪 = 月薪 ÷ 21.75 ÷ 8
- **调休管理**：休息日加班可调休，调休后按 1 倍时薪计算（休息的那天抵扣了额外 1 倍）
- **节假日管理**：预置 2026 年法定节假日和调休补班日，可自定义
- **月度统计**：按日期类型分类统计加班时长和费用

## 部署步骤

### 1. 安装 Wrangler

```bash
npm install -g wrangler
# 或在项目目录内
npm install
```

### 2. 登录 Cloudflare

```bash
wrangler login
```

浏览器会打开授权页面，点击允许即可。

### 3. 创建 D1 数据库

```bash
wrangler d1 create overtime-tracker
```

命令会输出类似：

```
✅ Successfully created DB 'overtime-tracker'
[[d1_databases]]
binding = "DB"
database_name = "overtime-tracker"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

### 4. 填入数据库 ID

把上一步输出的 `database_id` 填入 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "overtime-tracker"
database_id = "这里粘贴你的数据库ID"
```

### 5. 初始化数据库表

```bash
wrangler d1 execute overtime-tracker --remote --file=schema.sql
```

这会创建所有表并预置 2026 年节假日数据。

### 6. 部署

```bash
wrangler deploy
```

部署完成后会输出 Worker 的访问地址，类似：
`https://overtime-tracker.<你的子域名>.workers.dev`

直接用手机浏览器打开即可使用。

### 7. （可选）绑定自定义域名

在 Cloudflare 控制台 → Workers & Pages → 你的 Worker → Settings → Domains & Routes 中添加自定义域名。

## 本地开发

```bash
# 初始化本地数据库
wrangler d1 execute overtime-tracker --local --file=schema.sql

# 启动本地开发服务器
wrangler dev
```

访问 `http://localhost:8787`

## 使用说明

1. 打开网址，注册账号
2. 进入「设置」填写月工资和标准上下班时间
3. 每天加班结束后，在首页输入下班时间，点击「记录加班」
4. 系统自动判断当天是工作日/休息日/节假日，计算对应倍率的加班费
5. 如果是休息日加班，可以在记录列表点「调休」，选择调休日期，加班费从 2 倍降为 1 倍
6. 在「设置」中可以管理节假日和调休补班日

## 技术栈

- Cloudflare Workers（无服务器运行时）
- Cloudflare D1（SQLite 数据库）
- 单文件架构：API + 前端页面全部内嵌在一个 Worker 中
