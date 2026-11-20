using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: AssemblyTitle("简图 SciPlot")]
[assembly: AssemblyDescription("本地科研绘图与数据处理工作台")]
[assembly: AssemblyProduct("SciPlot")]
[assembly: AssemblyVersion("2.0.0.0")]
[assembly: AssemblyFileVersion("2.0.0.0")]

namespace SciPlot.Desktop
{
    internal static class Program
    {
        internal const string WindowTitle = "简图 SciPlot · 科研绘图与数据处理";

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr FindWindow(string className, string windowName);
        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr window, int command);

        [STAThread]
        private static void Main()
        {
            bool firstInstance;
            using (Mutex instance = new Mutex(true, "Local\\SciPlot.Desktop.Main", out firstInstance))
            {
                if (!firstInstance)
                {
                    IntPtr existing = FindWindow(null, WindowTitle);
                    if (existing != IntPtr.Zero)
                    {
                        ShowWindow(existing, 9);
                        SetForegroundWindow(existing);
                    }
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
                Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs args)
                {
                    MessageBox.Show("应用遇到问题：" + args.Exception.Message + "\n\n请保存项目后重新打开简图。", "简图 SciPlot", MessageBoxButtons.OK, MessageBoxIcon.Error);
                };
                try
                {
                    Application.Run(new MainWindow());
                }
                catch (Exception error)
                {
                    MessageBox.Show("简图无法启动。请完整解压应用文件夹后运行 SciPlot.exe。\n\n" + error.Message, "简图 SciPlot", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
        }
    }

    internal sealed class MainWindow : Form
    {
        private readonly WebView2 browser;
        private readonly Label loading;
        private readonly string applicationFolder;
        private bool closing;

        internal MainWindow()
        {
            Text = Program.WindowTitle;
            Size = new Size(1440, 960);
            MinimumSize = new Size(1000, 700);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(247, 249, 248);
            AutoScaleMode = AutoScaleMode.Dpi;
            Font = new Font("Microsoft YaHei UI", 9F);
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            applicationFolder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SciPlot");

            browser = new WebView2();
            browser.Dock = DockStyle.Fill;
            browser.DefaultBackgroundColor = Color.White;
            Controls.Add(browser);
            loading = new Label();
            loading.Text = "简图 SciPlot\n正在打开本地绘图工作台…";
            loading.TextAlign = ContentAlignment.MiddleCenter;
            loading.Font = new Font("Microsoft YaHei UI", 15F);
            loading.ForeColor = Color.FromArgb(22, 113, 95);
            loading.BackColor = BackColor;
            loading.Dock = DockStyle.Fill;
            Controls.Add(loading);
            loading.BringToFront();

            Shown += async delegate { await InitializeBrowserAsync(); };
            FormClosing += delegate { closing = true; };
            FormClosed += delegate { browser.Dispose(); };
        }

        private async Task InitializeBrowserAsync()
        {
            try
            {
                string contentFolder = Path.Combine(applicationFolder, "app");
                string profileFolder = Path.Combine(applicationFolder, "WebView2");
                Directory.CreateDirectory(contentFolder);
                Directory.CreateDirectory(profileFolder);
                string html;
                using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("SciPlot.index.html"))
                {
                    if (resource == null) throw new InvalidOperationException("内嵌页面缺失，请重新下载完整应用。");
                    using (StreamReader reader = new StreamReader(resource, Encoding.UTF8)) html = reader.ReadToEnd();
                }
                string indexPath = Path.Combine(contentFolder, "index.html");
                if (!File.Exists(indexPath) || File.ReadAllText(indexPath, Encoding.UTF8) != html)
                    File.WriteAllText(indexPath, html, new UTF8Encoding(false));

                CoreWebView2EnvironmentOptions options = new CoreWebView2EnvironmentOptions();
                options.Language = "zh-CN";
                CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, profileFolder, options);
                if (closing) return;
                await browser.EnsureCoreWebView2Async(environment);
                if (closing) return;
                CoreWebView2 core = browser.CoreWebView2;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.IsZoomControlEnabled = true;
                core.Settings.AreDefaultContextMenusEnabled = true;
                core.Settings.AreDevToolsEnabled = true;
                core.SetVirtualHostNameToFolderMapping("sciplot.local", contentFolder, CoreWebView2HostResourceAccessKind.DenyCors);
                core.NavigationStarting += HandleNavigation;
                core.NewWindowRequested += HandleNewWindow;
                core.DownloadStarting += HandleDownload;
                core.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs args)
                {
                    if (args.IsSuccess)
                    {
                        loading.Visible = false;
                        browser.Focus();
                    }
                    else if (!closing)
                    {
                        loading.Text = "页面未能打开，请关闭后重新启动简图。\n错误：" + args.WebErrorStatus;
                    }
                };
                core.ProcessFailed += delegate(object sender, CoreWebView2ProcessFailedEventArgs args)
                {
                    if (closing || IsDisposed) return;
                    BeginInvoke(new Action(delegate
                    {
                        if (closing) return;
                        MessageBox.Show(this, "绘图引擎意外停止。已保存的项目仍保留在本地，请重新打开简图。\n\n错误类型：" + args.ProcessFailedKind, "简图 SciPlot", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    }));
                };
                core.Navigate("https://sciplot.local/index.html");
            }
            catch (WebView2RuntimeNotFoundException)
            {
                ShowStartupError("当前电脑缺少 Microsoft Edge WebView2 Runtime。\n\n请安装微软官方 Evergreen Runtime 后重新打开：\nhttps://developer.microsoft.com/microsoft-edge/webview2/\n\n简图本身无需安装 Node.js。", true);
            }
            catch (Exception error)
            {
                if (!closing) ShowStartupError("绘图工作台启动失败。请确认应用文件完整、用户目录可写，并已安装 Microsoft Edge WebView2 Runtime。\n\n" + error.Message, false);
            }
        }

        private void ShowStartupError(string message, bool missingRuntime)
        {
            if (closing || IsDisposed) return;
            loading.Text = missingRuntime ? "请先安装 Microsoft Edge WebView2 Runtime。" : "启动失败，请查看错误说明。";
            MessageBox.Show(this, message, "简图 SciPlot", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }

        private static bool IsLocalPage(string address)
        {
            Uri uri;
            return Uri.TryCreate(address, UriKind.Absolute, out uri) &&
                uri.Scheme == Uri.UriSchemeHttps && string.Equals(uri.Host, "sciplot.local", StringComparison.OrdinalIgnoreCase);
        }

        private void HandleNavigation(object sender, CoreWebView2NavigationStartingEventArgs args)
        {
            if (IsLocalPage(args.Uri) || args.Uri == "about:blank") return;
            args.Cancel = true;
            if (args.IsUserInitiated) OpenExternalLink(args.Uri);
        }

        private void HandleNewWindow(object sender, CoreWebView2NewWindowRequestedEventArgs args)
        {
            args.Handled = true;
            if (IsLocalPage(args.Uri)) browser.CoreWebView2.Navigate(args.Uri);
            else if (args.IsUserInitiated) OpenExternalLink(args.Uri);
        }

        private static void OpenExternalLink(string address)
        {
            Uri uri;
            if (!Uri.TryCreate(address, UriKind.Absolute, out uri) ||
                (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)) return;
            try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); }
            catch { /* External browser availability does not affect local work. */ }
        }

        private void HandleDownload(object sender, CoreWebView2DownloadStartingEventArgs args)
        {
            CoreWebView2Deferral deferral = args.GetDeferral();
            // Post the native dialog after the WebView callback returns. A modal
            // WinForms dialog inside the callback would cause WebView reentrancy.
            BeginInvoke(new Action(delegate
            {
                try
                {
                    if (closing) { args.Cancel = true; return; }
                    using (SaveFileDialog dialog = new SaveFileDialog())
                    {
                        dialog.Title = "保存简图文件";
                        dialog.FileName = Path.GetFileName(args.ResultFilePath);
                        dialog.InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
                        dialog.OverwritePrompt = true;
                        dialog.AddExtension = true;
                        string extension = Path.GetExtension(dialog.FileName).ToLowerInvariant();
                        dialog.Filter = extension == ".png" ? "PNG 图片 (*.png)|*.png|所有文件 (*.*)|*.*" :
                            extension == ".svg" ? "SVG 矢量图 (*.svg)|*.svg|所有文件 (*.*)|*.*" :
                            extension == ".csv" ? "CSV 数据 (*.csv)|*.csv|所有文件 (*.*)|*.*" :
                            extension == ".json" ? "JSON 项目 (*.json)|*.json|所有文件 (*.*)|*.*" : "所有文件 (*.*)|*.*";
                        if (dialog.ShowDialog(this) != DialogResult.OK) { args.Cancel = true; return; }
                        args.ResultFilePath = dialog.FileName;
                        args.Handled = true;
                    }
                }
                catch (Exception error)
                {
                    args.Cancel = true;
                    if (!closing) MessageBox.Show(this, "文件未能保存：" + error.Message, "简图 SciPlot", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
                finally { deferral.Complete(); }
            }));
        }
    }
}
