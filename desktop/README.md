# 简图 SciPlot Windows 桌面版

解压 Windows 发布包后，打开 `SciPlot-Windows` 文件夹并双击 `SciPlot.exe`。请保留同目录中的 DLL 和配置文件，不要只复制 EXE。应用在独立窗口中运行，使用时不需要 Node.js、浏览器标签页或联网加载前端依赖。

## 系统要求

适用于 Windows 10/11。电脑需要 Microsoft .NET Framework 4.8 和 Microsoft Edge WebView2 Evergreen Runtime；这些组件在许多 Windows 电脑上已经安装。若应用提示组件缺失，请通过微软官网下载运行时：

- [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)：选择适合系统架构的 Evergreen Runtime。离线安装可使用 Evergreen Standalone Installer。
- [.NET Framework 4.8 Runtime](https://dotnet.microsoft.com/en-us/download/dotnet-framework/net48)：运行应用只需 Runtime。

当前发布包未进行商业代码签名。

## 本地数据

桌面版将内嵌的应用页面释放到 `%LOCALAPPDATA%\SciPlot\app\index.html`，WebView2 用户数据固定保存在 `%LOCALAPPDATA%\SciPlot\WebView2`。页面使用 `https://sciplot.local/index.html` 映射本机文件；这个地址不连接远程服务器。稳定的来源地址使本地项目和模板可以跨启动保留。

数据导入、处理、绘图和导出都在设备上完成。移动程序文件夹不会改变用户数据目录。重要项目仍建议使用“保存项目”导出 JSON 文件备份。删除用户数据目录会清除自动保存的项目、模板及其他浏览器本地记录。

## 从源码构建

在项目根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File desktop/build-windows.ps1
```

构建环境需要 Node.js 20 或更新版本和 Windows 自带的 .NET Framework C# 编译器。脚本会重新生成独立 HTML，再将页面作为资源内嵌进 EXE。Node.js 仅用于构建，最终使用者无需安装。

WebView2 SDK 锁定为 `Microsoft.Web.WebView2 1.0.4314.35`，由构建脚本从 NuGet 官方源取得。首次构建需要联网下载 SDK；本地缓存可供后续构建复用。NuGet 包缓存和生成的发布文件不应提交到源码仓库。前端所需的 SheetJS 是随项目提供的本地资源，应用运行时无需从 CDN 下载。

产物位于 `release/SciPlot-Windows/SciPlot.exe`，以及同级生成的 ZIP 发布包。`create-icon.ps1` 使用 System.Drawing 生成多分辨率 ICO 和 PNG，`app.manifest` 声明普通用户权限与高 DPI 支持，`App.config` 配置 .NET Framework 4.8。
