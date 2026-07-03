# Max Terminal

跨平台 SSH 客户端，基于 Tauri 2 + React + Rust 构建。

## 功能

- 本地 SQLite 保存 SSH 连接配置（密码/私钥）
- SSH 终端（xterm.js）
- SFTP 远程文件浏览（左侧文件树）
- 文本文件预览与编辑（Monaco Editor）

## 开发

```bash
npm install
npm run tauri dev
```

## 打包

```bash
npm run tauri build
```

打包产物位于 `src-tauri/target/release/bundle/`。

## 发布（GitHub Actions）

推送 `v*` 格式的 tag 时，会自动在 macOS（Apple Silicon + Intel）、Windows x64、Linux x64/ARM64 上编译，并创建 Draft Release。

```bash
# 1. 更新版本号（package.json 与 src-tauri/tauri.conf.json 保持一致）
# 2. 提交并打 tag
git tag v0.1.0
git push origin v0.1.0
```

也可在 GitHub Actions 页面手动触发 **Release** workflow（版本号取自 `tauri.conf.json`）。

**注意：**

- 需在仓库 Settings → Actions → General → Workflow permissions 中开启 **Read and write permissions**
- `ubuntu-22.04-arm` runner 仅公开仓库可用；私有仓库请删除 workflow 中对应 matrix 项
- 含 `-` 的 tag（如 `v0.1.0-beta.1`）会标记为 prerelease

## 技术栈

- **前端**: React 19, TypeScript, Vite, Tailwind CSS 4, Zustand, Monaco Editor, xterm.js
- **后端**: Rust, russh, russh-sftp, rusqlite, Tauri 2
