using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// Diagnostic observations only. Job accounting remains the completion/count
// authority. Completion notifications can race process exit or PID reuse:
// https://learn.microsoft.com/windows/win32/api/winnt/ns-winnt-jobobject_associate_completion_port
public sealed class RionWindowsJobProcessObservation
{
    public uint ProcessId { get; set; }
    public string ImagePath { get; set; }
    public int ImageQueryError { get; set; }
    public bool InJobAtObservation { get; set; }
}

public sealed class RionWindowsJobProcessDiagnostics : IDisposable
{
    private const int MaximumObservations = 128;
    private readonly IntPtr job;
    private readonly IntPtr port;
    private readonly Thread worker;
    private readonly List<RionWindowsJobProcessObservation> observations =
        new List<RionWindowsJobProcessObservation>();
    private bool disposed;
    private readonly ManualResetEvent emptyOrStopped = new ManualResetEvent(false);
    private volatile bool receivedEmptyNotification;
    public bool Truncated { get; private set; }
    public int NotificationError { get; private set; }
    public int ActiveSnapshotError { get; private set; }
    public bool ActiveSnapshotTruncated { get; private set; }

    [StructLayout(LayoutKind.Sequential)]
    private struct CompletionAssociation
    {
        public IntPtr CompletionKey;
        public IntPtr CompletionPort;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateIoCompletionPort(
        IntPtr file, IntPtr existing, UIntPtr key, uint concurrency);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job, int informationClass, ref CompletionAssociation information, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetQueuedCompletionStatus(
        IntPtr port, out uint message, out UIntPtr key, out IntPtr process, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool PostQueuedCompletionStatus(
        IntPtr port, uint message, UIntPtr key, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool inJob);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(
        IntPtr process, uint flags, StringBuilder path, ref uint characters);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        IntPtr job, int informationClass, IntPtr information, uint length, IntPtr returnedLength);

    public RionWindowsJobProcessDiagnostics(IntPtr jobHandle)
    {
        job = jobHandle;
        port = CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, UIntPtr.Zero, 1);
        if (port == IntPtr.Zero) throw new Win32Exception();
        var association = new CompletionAssociation
        {
            CompletionKey = new IntPtr(1), CompletionPort = port
        };
        if (!SetInformationJobObject(job, 7, ref association,
            (uint)Marshal.SizeOf(typeof(CompletionAssociation))))
        {
            int error = Marshal.GetLastWin32Error();
            CloseHandle(port);
            throw new Win32Exception(error);
        }
        worker = new Thread(Observe) { IsBackground = true };
        worker.Start();
    }

    private void Observe()
    {
        while (true)
        {
            uint message;
            UIntPtr key;
            IntPtr value;
            // Event-bound diagnostic consumer; the parent posts cancellation.
            if (!GetQueuedCompletionStatus(port, out message, out key, out value, UInt32.MaxValue))
            {
                NotificationError = Marshal.GetLastWin32Error();
                emptyOrStopped.Set();
                return;
            }
            if (key == UIntPtr.Zero) { emptyOrStopped.Set(); return; }
            if (message == 4) // JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO
            {
                receivedEmptyNotification = true;
                emptyOrStopped.Set();
                continue;
            }
            if (message != 6) continue; // JOB_OBJECT_MSG_NEW_PROCESS
            lock (observations)
            {
                if (observations.Count == MaximumObservations)
                {
                    Truncated = true;
                    continue;
                }
                observations.Add(ReadImage(unchecked((uint)value.ToInt64())));
            }
        }
    }

    private RionWindowsJobProcessObservation ReadImage(uint processId)
    {
        var observation = new RionWindowsJobProcessObservation { ProcessId = processId };
        IntPtr process = OpenProcess(0x1000, false, processId); // QUERY_LIMITED_INFORMATION
        if (process == IntPtr.Zero)
        {
            observation.ImageQueryError = Marshal.GetLastWin32Error();
            return observation;
        }
        try
        {
            bool inJob;
            if (!IsProcessInJob(process, job, out inJob))
            {
                observation.ImageQueryError = Marshal.GetLastWin32Error();
                return observation;
            }
            observation.InJobAtObservation = inJob;
            if (!inJob) return observation;
            var image = new StringBuilder(32768);
            uint characters = (uint)image.Capacity;
            if (!QueryFullProcessImageName(process, 0, image, ref characters))
                observation.ImageQueryError = Marshal.GetLastWin32Error();
            else
                observation.ImagePath = image.ToString();
            return observation;
        }
        finally { CloseHandle(process); }
    }

    public RionWindowsJobProcessObservation[] Snapshot()
    {
        lock (observations) { return observations.ToArray(); }
    }

    public void WaitForEmptyNotification(int remainingMilliseconds)
    {
        // This is only an event wakeup. The caller must subsequently query native
        // Job accounting; neither notification nor elapsed time establishes PASS.
        if (!emptyOrStopped.WaitOne(Math.Max(0, remainingMilliseconds)))
            throw new TimeoutException("The exited root's Job accounting notification did not arrive within the original command deadline.");
        if (receivedEmptyNotification) return;
        if (NotificationError != 0) throw new Win32Exception(NotificationError);
        throw new InvalidOperationException("The Job notification stream stopped before the empty notification.");
    }

    public RionWindowsJobProcessObservation[] SnapshotActive()
    {
        // One bounded observation at root exit, before cleanup. This is not a
        // liveness scan or a replacement for authoritative Job accounting.
        int length = 8 + IntPtr.Size * MaximumObservations;
        IntPtr buffer = Marshal.AllocHGlobal(length);
        try
        {
            if (!QueryInformationJobObject(job, 3, buffer, (uint)length, IntPtr.Zero))
            {
                ActiveSnapshotError = Marshal.GetLastWin32Error();
                ActiveSnapshotTruncated = ActiveSnapshotError == 234; // ERROR_MORE_DATA
                return new RionWindowsJobProcessObservation[0];
            }
            int count = Marshal.ReadInt32(buffer, 4);
            if (count < 0 || count > MaximumObservations)
            {
                ActiveSnapshotError = 13; // ERROR_INVALID_DATA
                return new RionWindowsJobProcessObservation[0];
            }
            var active = new RionWindowsJobProcessObservation[count];
            for (int index = 0; index < count; index++)
                active[index] = ReadImage(unchecked((uint)Marshal.ReadIntPtr(
                    buffer, 8 + IntPtr.Size * index).ToInt64()));
            return active;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        bool posted = PostQueuedCompletionStatus(port, 0, UIntPtr.Zero, IntPtr.Zero);
        int postError = posted ? 0 : Marshal.GetLastWin32Error();
        if (!posted) CloseHandle(port); // Releases a pending completion wait.
        // Same bounded cleanup allowance as the parent Job Object runner.
        bool stopped = worker.Join(30000);
        if (posted) CloseHandle(port);
        if (!stopped) throw new TimeoutException("Windows Job diagnostic consumer did not stop.");
        emptyOrStopped.Dispose();
        if (!posted) throw new Win32Exception(postError);
    }
}
