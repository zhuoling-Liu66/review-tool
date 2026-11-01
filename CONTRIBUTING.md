# 贡献指南

感谢关注 `review-tool`。

## 开始之前

- 这是一个早期个人项目。较大的改动请先开 issue，确认范围后再动手。
- 提交 bug 时，请提供命令、目标仓库的大致结构（不要贴源码）、退出码，以及相关 `.review/` 产物路径。
- 不要在 issue、PR 或日志里粘贴 API key、token、客户代码或其他敏感信息。

## 开发环境

```bash
npm ci
npm run typecheck
npm test
npm run build
```

测试使用临时 git 仓库和 mock 模型，不会调用真实模型。

## 提交 PR

- 一个 PR 只解决一个问题，保持改动聚焦。
- 行为变化需要补充或更新测试。
- 提交前运行 `npm run typecheck`、`npm test` 和 `npm run build`。
- 行为、命令、配置或限制发生变化时，同步更新 README 或 `docs/`。
- 不要提交 `dist/`、`node_modules/`、`.review/`、`.env*` 或生成的报告。

## 安全

敏感漏洞请通过 GitHub Security Advisories 私下报告，详见 [SECURITY.md](SECURITY.md)。
