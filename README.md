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

## 技术栈

- **前端**: React 19, TypeScript, Vite, Tailwind CSS 4, Zustand, Monaco Editor, xterm.js
- **后端**: Rust, russh, russh-sftp, rusqlite, Tauri 2
