# 求职工作台（Job Portal）

纪子悦个人求职助手：素材库 / 知识库 / 简历 / 投递进度 / 网申助手 一站式本地工作台。

## 启动

方式一：双击 `start-job-app.bat`（自动启动服务并打开浏览器）。

方式二：命令行

```bash
node server.js
```

浏览器打开 <http://localhost:3000>。

服务跑在 3000 端口，窗口别关。首次用前在页面「设置」里填 DeepSeek（或任意 OpenAI 兼容）API Key。

## 目录结构

```
job-app/
├── server.js            # Express 后端（含 token 加固、AI 问答生成、投递进度接口）
├── public/              # 前端单页应用（app.js / index.html / styles.css）
├── extension/           # Chrome 网申助手扩展（MV3）
│   ├── manifest.json
│   ├── background.js    # 代理本机请求、持令牌
│   └── content.js       # 字段识别/填充/问答生成
├── data/
│   ├── store/           # 全部数据：material / knowledge / jobs / resumes /
│   │                    #   apply / tracker / career / recs / cv / interview
│   ├── seed/            # 种子数据
│   ├── token.txt        # 本机接口令牌（服务自动生成，勿外传）
│   └── uploads/         # 上传的图片/附件
├── config.json          # API Key 配置（含密钥，勿外传/勿提交）
├── package.json
├── start-job-app.bat    # 一键启动
└── node_modules/
```

## Chrome 网申助手扩展（可选）

1. Chrome 打开 `chrome://extensions`
2. 右上角开「开发者模式」
3. 点「加载已解压的扩展程序」→ 选 `extension/` 文件夹
4. 保持 `node server.js` 运行；打开任意网申页，右下角出现 ◈ 球即生效

扩展只填不提交，填过的字段有蓝色描边，复核后自己点提交。

## 数据备份

所有数据都在 `data/store/*.json`（纯文本）。备份/迁移：整个 `job-app` 文件夹拷走即可，`node_modules` 可重装（`npm install`）。
