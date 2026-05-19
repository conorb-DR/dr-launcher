using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;

class DRLauncher
{
    static readonly string LocalAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    static readonly string PidFile = Path.Combine(LocalAppData, "DR Launcher", "server.pid");

    static int Main()
    {
        string appDir = AppDomain.CurrentDomain.BaseDirectory;
        string nodeExe = Path.Combine(appDir, "node", "node.exe");
        string serverJs = Path.Combine(appDir, "app", "server.js");
        string openBrowserJs = Path.Combine(appDir, "open-browser.js");

        if (!File.Exists(nodeExe))
        {
            ShowError("node.exe not found at: " + nodeExe);
            return 1;
        }

        int existingPort = GetRunningServerPort(serverJs);
        if (existingPort > 0)
        {
            OpenBrowser(existingPort);
            return 0;
        }

        StartServer(nodeExe, serverJs);

        int port = WaitForServer(10000);
        if (port > 0)
        {
            OpenBrowser(port);
        }
        else
        {
            RunOpenBrowser(nodeExe, openBrowserJs);
        }

        return 0;
    }

    static int GetRunningServerPort(string expectedServerJs)
    {
        try
        {
            if (!File.Exists(PidFile)) return 0;
            string content = File.ReadAllText(PidFile).Trim();

            int pid = ExtractJsonInt(content, "pid");
            int port = ExtractJsonInt(content, "port");
            if (pid <= 0 || port <= 0) return 0;

            Process proc;
            try { proc = Process.GetProcessById(pid); }
            catch { return 0; }

            if (proc.HasExited) return 0;

            if (Ping(port)) return port;
        }
        catch { }
        return 0;
    }

    static void StartServer(string nodeExe, string serverJs)
    {
        var psi = new ProcessStartInfo
        {
            FileName = nodeExe,
            Arguments = "\"" + serverJs + "\" --no-open --packaged",
            WorkingDirectory = Path.GetDirectoryName(serverJs),
            CreateNoWindow = true,
            UseShellExecute = false,
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        Process.Start(psi);
    }

    static int WaitForServer(int timeoutMs)
    {
        int elapsed = 0;
        while (elapsed < timeoutMs)
        {
            Thread.Sleep(500);
            elapsed += 500;

            try
            {
                if (!File.Exists(PidFile)) continue;
                string content = File.ReadAllText(PidFile).Trim();
                int port = ExtractJsonInt(content, "port");
                if (port > 0 && Ping(port)) return port;
            }
            catch { }
        }
        return 0;
    }

    static bool Ping(int port)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/ping");
            req.Timeout = 2000;
            req.Method = "GET";
            using (var resp = (HttpWebResponse)req.GetResponse())
            {
                return resp.StatusCode == HttpStatusCode.OK;
            }
        }
        catch { return false; }
    }

    static void OpenBrowser(int port)
    {
        Process.Start(new ProcessStartInfo
        {
            FileName = "http://127.0.0.1:" + port,
            UseShellExecute = true,
        });
    }

    static void RunOpenBrowser(string nodeExe, string openBrowserJs)
    {
        if (!File.Exists(openBrowserJs)) return;
        var psi = new ProcessStartInfo
        {
            FileName = nodeExe,
            Arguments = "\"" + openBrowserJs + "\" --wait",
            CreateNoWindow = true,
            UseShellExecute = false,
        };
        Process.Start(psi);
    }

    static int ExtractJsonInt(string json, string key)
    {
        string pattern = "\"" + key + "\":";
        int idx = json.IndexOf(pattern, StringComparison.Ordinal);
        if (idx < 0) return 0;
        idx += pattern.Length;
        while (idx < json.Length && json[idx] == ' ') idx++;
        int start = idx;
        while (idx < json.Length && char.IsDigit(json[idx])) idx++;
        if (idx == start) return 0;
        int result;
        int.TryParse(json.Substring(start, idx - start), out result);
        return result;
    }

    static void ShowError(string message)
    {
        File.WriteAllText(
            Path.Combine(LocalAppData, "DR Launcher", "launcher-error.log"),
            DateTime.Now.ToString("o") + " " + message + Environment.NewLine);
    }
}
