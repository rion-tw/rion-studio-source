using System;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class InlinePowerShellTestJob
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public uint cb;
        public string reserved, desktop, title;
        public uint x, y, width, height, charsX, charsY, fill, flags;
        public ushort show, reservedBytes;
        public IntPtr reserved2, input, output, error;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr process, thread;
        public uint processId, threadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(string app, StringBuilder command,
        IntPtr processAttributes, IntPtr threadAttributes, bool inherit,
        uint flags, IntPtr environment, string directory,
        ref StartupInfo startup, out ProcessInformation process);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int informationClass,
        IntPtr information, uint length, IntPtr returnedLength);

    public static uint[] Run(IntPtr job, string executable, string encoded, string directory,
        RionWindowsJobProcessDiagnostics observer)
    {
        var startup = new StartupInfo {
            cb = (uint)Marshal.SizeOf<StartupInfo>(), flags = 1, show = 0
        };
        ProcessInformation process;
        // Hidden new console; assign while suspended, before the script runs.
        if (!CreateProcessW(executable,
            new StringBuilder("\"" + executable + "\" -NoLogo -NoProfile -NonInteractive -EncodedCommand " + encoded),
            IntPtr.Zero, IntPtr.Zero, false, 0x14, IntPtr.Zero, directory,
            ref startup, out process)) throw new System.ComponentModel.Win32Exception();
        try
        {
            if (!AssignProcessToJobObject(job, process.process))
                throw new System.ComponentModel.Win32Exception();
            var clock = Stopwatch.StartNew();
            if (ResumeThread(process.thread) == uint.MaxValue)
                throw new System.ComponentModel.Win32Exception();
            if (WaitForSingleObject(process.process, 5000) != 0)
                throw new Exception("The inline PowerShell fixture exceeded its five-second boundary.");
            uint exit;
            if (!GetExitCodeProcess(process.process, out exit))
                throw new System.ComponentModel.Win32Exception();
            IntPtr information = Marshal.AllocHGlobal(48);
            try
            {
                if (!QueryInformationJobObject(job, 1, information, 48, IntPtr.Zero))
                    throw new System.ComponentModel.Win32Exception();
                uint initialActive = (uint)Marshal.ReadInt32(information, 40);
                uint? drainedHost = null;
                if (initialActive != 0 && RionWindowsJobRunner.CanJoinExitedRootAccounting(
                    job, process.process, process.processId))
                {
                    observer.WaitForEmptyNotification((int)Math.Max(0, 5000 - clock.ElapsedMilliseconds));
                    if (!QueryInformationJobObject(job, 1, information, 48, IntPtr.Zero))
                        throw new System.ComponentModel.Win32Exception();
                }
                if (Marshal.ReadInt32(information, 40) != 0)
                {
                    drainedHost = RionWindowsJobRunner.DrainSoleConsoleHost(job,
                        (int)Math.Max(0, 5000 - clock.ElapsedMilliseconds));
                    if (drainedHost.HasValue)
                    {
                        observer.WaitForEmptyNotification((int)Math.Max(0, 5000 - clock.ElapsedMilliseconds));
                        if (!QueryInformationJobObject(job, 1, information, 48, IntPtr.Zero))
                            throw new System.ComponentModel.Win32Exception();
                    }
                }
                if (!QueryInformationJobObject(job, 1, information, 48, IntPtr.Zero))
                    throw new System.ComponentModel.Win32Exception();
                return new uint[] { exit, process.processId,
                    (uint)Marshal.ReadInt32(information, 36),
                    (uint)Marshal.ReadInt32(information, 40), initialActive,
                    drainedHost ?? uint.MaxValue };
            }
            finally { Marshal.FreeHGlobal(information); }
        }
        finally
        {
            TerminateJobObject(job, 1);
            CloseHandle(process.thread);
            CloseHandle(process.process);
        }
    }
}
