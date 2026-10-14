<!--
面向 Agent 的中文文档：pi-adb-remote 在 Android 设备上做什么、如何把 Pi 的工具路由到设备、
完整的命令与 action、配置项、会话行为、安全边界与故障排查。与 README.md 语义一致。
-->

# pi-adb-remote

**把 Android 设备变成 Pi 的工作区——走 `adb`，不是 SSH。**

[English](README.md) · [更新日志](CHANGELOG.md)

`pi-adb-remote` 把手机或模拟器变成 Pi 的当前工作区。连接之后，Pi 仍然使用它自己的 `read`、`write`、`edit`、
`bash`、`ls`、`grep`、`find` 工具——但这些操作发生在设备上。没有人需要把命令包成 `adb shell`，不需要来回拷文件，
模型也不必同时维护两套 shell 的心智模型。

```text
你：连我的 Pixel，打开 /data/local/tmp/logs，找出上一次采集为什么失败，
    改配置，然后重跑，把日志路径给我。

Pi：adb connect → pwd → ls logs → 读最新日志 → 改配置 →
    重跑采集 → 把结果 pull 回电脑
```

所有操作都以 shell 用户（`uid 2000`）身份执行：不需要 root，不需要 Magisk，手机上也不用装任何 App。

## 环境要求

| 要求 | 说明 |
| --- | --- |
| 已加载本扩展的 Pi | `pi install npm:pi-adb-remote`，或放进 `~/.pi/agent/extensions/` |
| Android platform-tools | `adb` 在 `PATH` 中（测试或自定义构建可用 `ADB` 覆盖） |
| 已开启 USB 调试的设备 | 或使用无线调试；无线配对需要 Android 11+ |
| Node.js ≥ 20 | Pi 的 TypeScript 加载器运行本扩展 |

## 连接之后有什么不同

| Pi 做的事 | 实际执行位置 |
| --- | --- |
| `read`、`write`、`edit` | 设备文件系统，相对设备工作目录解析 |
| `bash` | 每条命令一次 `adb shell`，退出码与超时都保留 |
| `ls`、`grep`、`find` | 在设备上，使用设备自带的 `sh` 兼容搜索工具 |
| `!ls`（你的 `!` 终端命令） | 在设备上，包括会持久生效的 `cd` |
| `adb` | 设备控制面：连接、截屏、文件、APK、端口、备注、记忆 |
| `/adb` | 同样的控制面给你用，带 Tab 补全 |

其它一切都不动。你的电脑工作目录、Pi 自己的文件、其它扩展都不受影响，所以一个刷镜像、改 init 脚本、
再 grep `logcat` 的会话全程不需要离开当前项目。

## 连接

```text
/adb                          连接已保存（活动）的 endpoint
/adb 0A1B2C3D4E5F6            连接序列号 → 规范化为 `adb -s 0A1B2C3D4E5F6`
/adb use pixel-test           切换到已保存的 endpoint
/adb devices                  adb 能看到什么
/adb pair 192.168.1.20:37021  无线配对（配对码在提示框输入，绝不保存）
/adb status                   设备、路由、cwd、输出预算、forward、备注
/adb disconnect               回到本地工作区
```

也可以直接对 Pi 说，由 Agent 调用 `adb` 工具：

```json
{ "action": "connect", "command": "adb -s 0A1B2C3D4E5F6" }
```

`adb` 是一个工具、一组扁平的 action，模型只面对一个表面，不会有好几个相似工具可选：

| Action | 作用 |
| --- | --- |
| `connect`、`reconnect`、`disconnect` | endpoint 生命周期（绝不自动挑设备） |
| `devices`、`status` | adb 看到什么 / 本会话正在做什么 |
| `pair`、`forward`、`unforward` | 无线配对，把设备端口暴露成本机 `localhost:<port>` |
| `exec` | 单条设备命令，带完整输出信封 |
| `chdir` | 持久修改设备工作目录 |
| `screen` | 实时 PNG 截屏（图像块），并在电脑上留一份 |
| `pull`、`push` | 设备 ↔ 电脑，支持目录 |
| `install`、`uninstall` | 安装 APK；`uninstall` 一定先问你 |
| `note`、`memory` | endpoint 备注 / 按设备保存的长期笔记 |

设备文件用绝对路径寻址；相对路径相对设备工作目录解析。单条设备命令可以在命令行上限幅：

```text
/adb exec getprop ro.build.version.release
/adb exec --timeout 120 dumpsys activity recents
/adb exec --lines 20 logcat -d -v brief
/adb exec -- grep -c . /data/local/tmp/notes.txt
```

## 设备不是一台 Linux 服务器

传输层是围绕 `adb` 的真实能力建的，差异会被说明，而不是被藏起来：

- **只有一个 `sh`，没有 PTY。** 命令被组织成
  `adb -s <serial> exec-out "sh -c '<argv-safe command>'"`——一帧完成，调用方不拼 shell 字符串，
  退出码走独立通道，所以 shell 的最后一句话伪造不了成功。
- **没有 `bash`，没有 GNU 工具。** 只有 Toybox：`timeout -k 5 -s TERM N`（只支持短选项）、用
  `sed -n 'a,bp'` 取行区间、用 `stat -L -c '%F|%a|%s'` 取元数据。缺失的 applet 会被报告，而不是模拟。
- **可写目录只有 `/data/local/tmp` 及其子目录。** 这是默认设备工作区，会话可以在其中移动
  （`/adb cd /data/local/tmp/repo`）；`/sdcard` 写入失败会被说明为 FUSE/SELinux 边界，而不是推给扩展。
- **文本还是二进制由内容决定。** 先嗅探前 8 KB，再决定是拒绝、按区间读，还是流式处理；大二进制永远不会被灌进上下文。
- **截图与 APK 按字节处理**，绝不当文本：`screen` 返回模型真正能“看见”的 PNG 图像块，同时在电脑的会话临时目录留一份。

## 安全边界

- **不静默换设备。** 会话绑定设备身份（`ro.serialno`）。如果接上的不是保存过的那台，扩展会拒绝并停止路由。
- **不重试写操作。** 超时或掉线只报告“结果未知”；只有只读类操作会自动重试，重连由单飞 Promise 共享。
- **不擅自卸载或覆盖。** `uninstall` 需要你的确认；`push`、`pull` 未经同意不覆盖已有文件。
- **配对码不进 argv**、上下文、配置与会话记录——它只通过 stdin 交给 `adb pair`。
- **输出天然有界**：单次命令的字节与行数预算、每轮模型输出总预算，超额的完整输出 spill 到电脑上的文件。

## 配置

`~/.pi/agent/adb-remote-config.json`，每个 endpoint 一条；机器状态，用 `/adb config` 写就好。

```json
{
  "activeEndpoint": "adb -s 0A1B2C3D4E5F6",
  "endpoints": {
    "adb -s 0A1B2C3D4E5F6": {
      "adbCommand": "adb -s 0A1B2C3D4E5F6",
      "deviceCwd": "/data/local/tmp",
      "note": "test Pixel",
      "forwards": ["19000:tcp:5555"],
      "imageMaxBytes": 8388608
    }
  },
  "displayLines": 5,
  "readMaxBytes": 16384,
  "readMaxLines": 400,
  "execMaxBytes": 8192,
  "execMaxLines": 200,
  "turnMaxBytes": 32768
}
```

| 键 | 作用域 | 默认 | 含义 |
| --- | --- | --- | --- |
| `activeEndpoint` | 全局 | 最近连接 | 裸 `/adb` 与新会话使用的 endpoint |
| `adbCommand` | endpoint | `adb` | 完整选择命令（`adb`、`adb -s <serial>`） |
| `deviceCwd` | endpoint | `/data/local/tmp` | 持久设备工作目录 |
| `note` | endpoint | — | 设备备注，显示在 `status` 与设备列表中 |
| `forwards` | endpoint | 无 | 每次连接时恢复的 forward |
| `imageMaxBytes` | endpoint | 8 MB | `read` 工具可接受的最大图像（上限 64 MB） |
| `displayLines` | 全局 | 5（最大 50） | 折叠显示的设备命令行数 |
| `readMaxBytes` / `readMaxLines` | 全局 | 16 KB / 400 | `read` 默认区间 |
| `execMaxBytes` / `execMaxLines` | 全局 | 8 KB / 200 | 设备命令默认输出 |
| `turnMaxBytes` | 全局 | 32 KB | 每轮设备输出总预算（单次不低于 1 KB） |

通过命令修改，它会校验并保存：

```text
/adb config                                    打印全部配置
/adb config note "training phone"              endpoint 备注
/adb config cwd /data/local/tmp/repo           默认设备目录
/adb config forward 19000:tcp:5555             持久保存 forward
/adb config display-lines 12                   折叠显示行数
/adb config read-max-bytes 65536               单次读取字节预算
/adb config turn-max-bytes 65536               每轮输出预算
/adb config image-max-bytes 2097152            read 可接受的最大图像
```

## 会话与状态

| 事件 | 行为 |
| --- | --- |
| `/new` | 继承当前连接与路由（ scratch 目录重建） |
| `/fork`、`/clone` | 保留来源会话的设备、目录与路由 |
| `/resume` | 重连并恢复记录的目录、路由与 forward——换手机会被拒绝 |
| reload | 进程内保留连接；forward 重新登记而不会翻倍 |
| 退出 | 停止 forward、删除会话 scratch 目录、保存最后的 endpoint |

设备笔记（`/adb memory`、`adb(action="memory")`）保存在**电脑**上，按设备身份归档，并作为设备记忆上下文注入：
今天写的笔记，下次这台手机在任何项目里连上时都可用——不需要回到主机，也没有 `scp`。

## 故障排查

| 提示 | 含义 |
| --- | --- |
| `no devices/emulators found` | 查数据线、USB 调试、`adb devices`——endpoint 名字变不出设备 |
| `unauthorized` | 在手机上接受“允许 USB 调试”弹窗 |
| `device offline` | 手机还在稳定中；扩展会轮询 5 秒，然后提示你解锁并重插 |
| `more than one device/emulator` | 两个选择器冲突；`adb kill-server` 后显式指定 endpoint |
| `adb server version mismatch` | 升级 platform-tools；扩展会提示重启 server |
| `Local port N is already forwarded or in use` | 端口被别的工具占用——扩展只处理自己登记的 forward |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | 签名不同；先问用户再执行 `adb(action="uninstall")` |
| `screencap: permission denied` / 返回错误而不是 PNG | 屏幕被锁定，解锁后重试 |
| `Refusing to read device binary file as text` | 正确行为；改用 `pull`（图像用 `screen`） |

## 开发

```bash
npm run typecheck                  # 类型
npm test                           # 离线套件：脚本化的假 adb，不需要设备
PI_ADB_LIVE=1 npm run test:live    # 可选：对着真实设备运行
```

离线套件是发布门槛，CI 上无设备即可运行。实时套件在缺少环境变量或缺少设备时会自动跳过，并且会自行清理手机。
实测设备事实、故障目录与构建顺序记录在
[`ARCHITECTURE_PLAN_adb-remote-transport.md`](ARCHITECTURE_PLAN_adb-remote-transport.md)。

## 版本

| 版本 | 状态 | 摘要 |
| --- | --- | --- |
| [0.1.0](CHANGELOG.md#unreleased) | 开发中 | `pi-adb-remote` 首个版本：以 Android 设备传输层取代 SSH 工作区，设备化文件/命令/搜索工具，`adb` 控制工具与 `/adb` 命令 |

## 许可

MIT
