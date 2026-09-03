using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class RionWindowsJobResult
{
    public uint ExitCode { get; set; }
    public uint ActiveProcessesAfterRootExit { get; set; }
    public uint TotalProcesses { get; set; }
}

public static class RionWindowsJobRunner
{
    private const uint LogonWithProfile = 0x00000001;
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint WaitObject0 = 0;
    private const uint WaitTimeout = 0x00000102;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const int TerminationDrainMilliseconds = 30000;
    private static readonly HashSet<string> ProfileBoundEnvironmentNames =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "APPDATA",
            "HOME",
            "HOMEDRIVE",
            "HOMEPATH",
            "LOCALAPPDATA",
            "LOGONSERVER",
            "PSModulePath",
            "TEMP",
            "TMP",
            "USERDOMAIN",
            "USERDOMAIN_ROAMINGPROFILE",
            "USERNAME",
            "USERPROFILE"
        };
    private static readonly HashSet<string> SensitiveEnvironmentNames =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
            "ACTIONS_RUNTIME_TOKEN",
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "NODE_AUTH_TOKEN",
            "NPM_TOKEN",
            "PNPM_AUTH_TOKEN"
        };

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicAccountingInformation
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessWithLogonW(
        string username,
        string domain,
        string password,
        uint logonFlags,
        string applicationName,
        StringBuilder commandLine,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfo startupInfo,
        out ProcessInformation processInformation);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint length,
        IntPtr returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static RionWindowsJobResult Run(
        string username,
        string domain,
        string password,
        string applicationName,
        string commandLine,
        string workingDirectory,
        int commandTimeoutMilliseconds,
        string ephemeralUpdaterSigningKeyPath,
        string ephemeralUpdaterSigningKeyPassword)
    {
        if (commandTimeoutMilliseconds < 1000)
        {
            throw new ArgumentOutOfRangeException(nameof(commandTimeoutMilliseconds));
        }
        IntPtr job = IntPtr.Zero;
        IntPtr limitsBuffer = IntPtr.Zero;
        IntPtr accountingBuffer = IntPtr.Zero;
        IntPtr environmentBlock = IntPtr.Zero;
        int environmentBlockByteLength = 0;
        ProcessInformation process = new ProcessInformation();
        bool childCreated = false;
        bool childAssigned = false;
        RionWindowsJobResult result = null;
        Exception primaryFailure = null;
        Exception cleanupFailure = null;
        int accountingSize = Marshal.SizeOf(typeof(JobObjectBasicAccountingInformation));
        try
        {
            accountingBuffer = Marshal.AllocHGlobal(accountingSize);
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero)
            {
                throw new Win32Exception();
            }
            var limits = new JobObjectExtendedLimitInformation();
            limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            int limitsSize = Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation));
            limitsBuffer = Marshal.AllocHGlobal(limitsSize);
            Marshal.StructureToPtr(limits, limitsBuffer, false);
            if (!SetInformationJobObject(job, 9, limitsBuffer, (uint)limitsSize))
            {
                throw new Win32Exception();
            }

            var startup = new StartupInfo();
            startup.cb = (uint)Marshal.SizeOf(typeof(StartupInfo));
            // A null desktop inherits the caller's exact station and desktop,
            // whose DACL the PowerShell wrapper leased to this SID.
            startup.lpDesktop = null;
            environmentBlock = BuildEnvironmentBlock(
                ephemeralUpdaterSigningKeyPath,
                ephemeralUpdaterSigningKeyPassword,
                out environmentBlockByteLength);
            if (!CreateProcessWithLogonW(
                username,
                domain,
                password,
                LogonWithProfile,
                applicationName,
                new StringBuilder(commandLine),
                CreateSuspended | CreateUnicodeEnvironment,
                environmentBlock,
                workingDirectory,
                ref startup,
                out process))
            {
                throw new Win32Exception();
            }
            childCreated = true;
            if (!AssignProcessToJobObject(job, process.hProcess))
            {
                throw new Win32Exception();
            }
            childAssigned = true;
            uint resumeResult = ResumeThread(process.hThread);
            if (resumeResult == UInt32.MaxValue)
            {
                throw new Win32Exception();
            }
            uint rootWait = WaitForSingleObject(
                process.hProcess,
                (uint)commandTimeoutMilliseconds);
            if (rootWait == WaitTimeout)
            {
                throw new TimeoutException(
                    "The isolated Windows root command exceeded its cleanup-safe deadline.");
            }
            if (rootWait != WaitObject0)
            {
                throw new Win32Exception();
            }
            uint exitCode;
            if (!GetExitCodeProcess(process.hProcess, out exitCode))
            {
                throw new Win32Exception();
            }

            uint activeProcessesAfterRootExit = QueryActiveProcesses(
                job,
                accountingBuffer,
                accountingSize);
            uint totalProcesses = QueryTotalProcesses(
                job,
                accountingBuffer,
                accountingSize);
            if (activeProcessesAfterRootExit != 0 && !TerminateJobObject(job, 1))
            {
                throw new Win32Exception();
            }
            if (activeProcessesAfterRootExit != 0)
            {
                WaitForJobToDrain(job, accountingBuffer, accountingSize);
            }
            result = new RionWindowsJobResult
            {
                ExitCode = exitCode,
                ActiveProcessesAfterRootExit = activeProcessesAfterRootExit,
                TotalProcesses = totalProcesses
            };
        }
        catch (Exception error)
        {
            primaryFailure = error;
        }
        finally
        {
            var cleanupFailures = new List<Exception>();
            if (childCreated && !childAssigned && process.hProcess != IntPtr.Zero)
            {
                CaptureCleanupFailure(
                    cleanupFailures,
                    () => EnsureStandaloneProcessStopped(process.hProcess));
            }
            if (job != IntPtr.Zero && accountingBuffer != IntPtr.Zero)
            {
                CaptureCleanupFailure(
                    cleanupFailures,
                    () => EnsureJobStopped(job, accountingBuffer, accountingSize));
            }
            if (environmentBlock != IntPtr.Zero)
            {
                CaptureCleanupFailure(
                    cleanupFailures,
                    () => ZeroAndFreeEnvironmentBlock(
                        environmentBlock,
                        environmentBlockByteLength));
            }
            if (accountingBuffer != IntPtr.Zero)
            {
                CaptureCleanupFailure(
                    cleanupFailures,
                    () => Marshal.FreeHGlobal(accountingBuffer));
            }
            if (limitsBuffer != IntPtr.Zero)
            {
                CaptureCleanupFailure(
                    cleanupFailures,
                    () => Marshal.FreeHGlobal(limitsBuffer));
            }
            if (process.hThread != IntPtr.Zero)
            {
                CloseChecked(process.hThread, "process thread", cleanupFailures);
            }
            if (process.hProcess != IntPtr.Zero)
            {
                CloseChecked(process.hProcess, "process", cleanupFailures);
            }
            if (job != IntPtr.Zero)
            {
                CloseChecked(job, "Job Object", cleanupFailures);
            }
            if (cleanupFailures.Count != 0)
            {
                cleanupFailure = new AggregateException(
                    "The isolated Windows process tree cleanup failed.",
                    cleanupFailures);
            }
        }
        if (primaryFailure != null)
        {
            if (cleanupFailure != null)
            {
                throw new AggregateException(
                    "The isolated Windows command and its process-tree cleanup failed.",
                    primaryFailure,
                    cleanupFailure);
            }
            ExceptionDispatchInfo.Capture(primaryFailure).Throw();
        }
        if (cleanupFailure != null)
        {
            throw cleanupFailure;
        }
        if (result == null)
        {
            throw new InvalidOperationException("The isolated Windows Job Object produced no result.");
        }
        return result;
    }

    private static void EnsureStandaloneProcessStopped(IntPtr process)
    {
        uint state = WaitForSingleObject(process, 0);
        if (state == WaitObject0)
        {
            return;
        }
        if (state != WaitTimeout)
        {
            throw new Win32Exception();
        }
        if (!TerminateProcess(process, 1))
        {
            throw new Win32Exception();
        }
        uint terminatedState = WaitForSingleObject(process, TerminationDrainMilliseconds);
        if (terminatedState == WaitTimeout)
        {
            throw new TimeoutException(
                "The unassigned isolated Windows root process did not terminate.");
        }
        if (terminatedState != WaitObject0)
        {
            throw new Win32Exception();
        }
    }

    private static void EnsureJobStopped(
        IntPtr job,
        IntPtr accountingBuffer,
        int accountingSize)
    {
        var failures = new List<Exception>();
        uint? activeProcesses = null;
        try
        {
            activeProcesses = QueryActiveProcesses(job, accountingBuffer, accountingSize);
        }
        catch (Exception error)
        {
            failures.Add(error);
        }
        if (!activeProcesses.HasValue || activeProcesses.Value != 0)
        {
            if (!TerminateJobObject(job, 1))
            {
                failures.Add(new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Failed to terminate the isolated Windows Job Object."));
            }
            try
            {
                WaitForJobToDrain(job, accountingBuffer, accountingSize);
            }
            catch (Exception error)
            {
                failures.Add(error);
            }
        }
        if (failures.Count != 0)
        {
            throw new AggregateException(
                "The isolated Windows Job Object did not reach authoritative active-zero.",
                failures);
        }
    }

    private static void CaptureCleanupFailure(
        List<Exception> failures,
        Action cleanup)
    {
        try
        {
            cleanup();
        }
        catch (Exception error)
        {
            failures.Add(error);
        }
    }

    private static void CloseChecked(
        IntPtr handle,
        string label,
        List<Exception> failures)
    {
        if (!CloseHandle(handle))
        {
            failures.Add(new Win32Exception(
                Marshal.GetLastWin32Error(),
                $"Failed to close the isolated Windows {label} handle."));
        }
    }

    private static uint QueryActiveProcesses(
        IntPtr job,
        IntPtr accountingBuffer,
        int accountingSize)
    {
        return QueryAccountingInformation(job, accountingBuffer, accountingSize).ActiveProcesses;
    }

    private static uint QueryTotalProcesses(
        IntPtr job,
        IntPtr accountingBuffer,
        int accountingSize)
    {
        return QueryAccountingInformation(job, accountingBuffer, accountingSize).TotalProcesses;
    }

    private static JobObjectBasicAccountingInformation QueryAccountingInformation(
        IntPtr job,
        IntPtr accountingBuffer,
        int accountingSize)
    {
        if (!QueryInformationJobObject(
            job,
            1,
            accountingBuffer,
            (uint)accountingSize,
            IntPtr.Zero))
        {
            throw new Win32Exception();
        }
        return (JobObjectBasicAccountingInformation)Marshal.PtrToStructure(
            accountingBuffer,
            typeof(JobObjectBasicAccountingInformation));
    }

    private static void WaitForJobToDrain(
        IntPtr job,
        IntPtr accountingBuffer,
        int accountingSize)
    {
        var drainDeadline = Stopwatch.StartNew();
        while (QueryActiveProcesses(job, accountingBuffer, accountingSize) != 0)
        {
            if (drainDeadline.ElapsedMilliseconds >= TerminationDrainMilliseconds)
            {
                throw new TimeoutException(
                    "The isolated Windows Job Object did not drain after termination.");
            }
            Thread.Sleep(25);
        }
    }

    private static IntPtr BuildEnvironmentBlock(
        string ephemeralUpdaterSigningKeyPath,
        string ephemeralUpdaterSigningKeyPassword,
        out int byteLength)
    {
        bool hasEphemeralKeyPath = !String.IsNullOrEmpty(ephemeralUpdaterSigningKeyPath);
        bool hasEphemeralPassword = !String.IsNullOrEmpty(
            ephemeralUpdaterSigningKeyPassword);
        if (hasEphemeralKeyPath != hasEphemeralPassword)
        {
            throw new ArgumentException(
                "Ephemeral updater signing requires both fixture-bound values.");
        }
        if (
            (hasEphemeralKeyPath && ephemeralUpdaterSigningKeyPath.IndexOf('\0') >= 0) ||
            (hasEphemeralPassword && ephemeralUpdaterSigningKeyPassword.IndexOf('\0') >= 0))
        {
            throw new ArgumentException(
                "Ephemeral updater signing values cannot contain NUL.");
        }
        var entries = new List<string>();
        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            string name = Convert.ToString(entry.Key);
            if (IsProfileBoundEnvironmentName(name) || IsSensitiveEnvironmentName(name))
            {
                continue;
            }
            entries.Add(String.Concat(name, "=", entry.Value));
        }
        if (hasEphemeralKeyPath)
        {
            entries.Add(String.Concat(
                "TAURI_SIGNING_PRIVATE_KEY_PATH=",
                ephemeralUpdaterSigningKeyPath));
            entries.Add(String.Concat(
                "TAURI_SIGNING_PRIVATE_KEY_PASSWORD=",
                ephemeralUpdaterSigningKeyPassword));
        }
        entries.Sort(StringComparer.OrdinalIgnoreCase);
        string block = String.Join("\0", entries) + "\0\0";
        byteLength = checked(block.Length * sizeof(char));
        return Marshal.StringToHGlobalUni(block);
    }

    private static bool IsProfileBoundEnvironmentName(string name)
    {
        return ProfileBoundEnvironmentNames.Contains(name) ||
            name.StartsWith("OneDrive", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsSensitiveEnvironmentName(string name)
    {
        return SensitiveEnvironmentNames.Contains(name) ||
            name.StartsWith("TAURI_SIGNING_", StringComparison.OrdinalIgnoreCase) ||
            name.StartsWith(
                "RION_STUDIO_UPDATER_PRIVATE_",
                StringComparison.OrdinalIgnoreCase);
    }

    private static void ZeroAndFreeEnvironmentBlock(IntPtr block, int byteLength)
    {
        try
        {
            Marshal.Copy(new byte[byteLength], 0, block, byteLength);
        }
        finally
        {
            Marshal.FreeHGlobal(block);
        }
    }
}
