# 安全政策

## 支持的版本

当前为 v0.1.x。安全修复只应用到最新版本。

## 报告漏洞

如果漏洞可能泄露密钥、导致任意代码执行或绕过审查门禁，请不要开公开 issue。

请使用 GitHub 的私密漏洞报告：

<https://github.com/zhuoling-Liu66/review-tool/security/advisories/new>

报告中请包含：

- 受影响的命令和配置；
- 最小复现步骤；
- 预期行为和实际行为；
- 你认为的影响范围。

维护者会尽力处理，但这是个人项目，请预留修复时间，再公开披露。

## 密钥

- 模型 API key 只从环境变量读取。
- 不要把真实 key 写进 `.review/config.yml`、测试数据、issue、PR 或报告。
- `.review/`、`.env` 和 `.env.*` 已被 git 忽略，但提交前仍应检查 `git status`。
