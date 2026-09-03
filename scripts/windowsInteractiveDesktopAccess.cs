using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;

public sealed class RionDesktopAccessLease
{
    public byte[] WindowStationDescriptor { get; set; }
    public byte[] DesktopDescriptor { get; set; }
}

public static class RionInteractiveDesktopAccess
{
    private const int DaclSecurityInformation = 4;
    private const int WindowStationAllAccess = 0x000F037F;
    private const int DesktopAllAccess = 0x000F01FF;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetProcessWindowStation();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetThreadDesktop(uint threadId);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetUserObjectSecurity(
        IntPtr handle,
        ref int requested,
        byte[] descriptor,
        uint length,
        out uint needed);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetUserObjectSecurity(
        IntPtr handle,
        ref int requested,
        byte[] descriptor);

    public static RionDesktopAccessLease Grant(string sidValue)
    {
        IntPtr windowStation = GetProcessWindowStation();
        IntPtr desktop = GetThreadDesktop(GetCurrentThreadId());
        byte[] oldWindowStation = Read(windowStation);
        byte[] oldDesktop = Read(desktop);
        var sid = new SecurityIdentifier(sidValue);
        Write(windowStation, AddAllowAce(oldWindowStation, sid, WindowStationAllAccess));
        try
        {
            Write(desktop, AddAllowAce(oldDesktop, sid, DesktopAllAccess));
        }
        catch (Exception primaryFailure)
        {
            try
            {
                Write(windowStation, oldWindowStation);
            }
            catch (Exception rollbackFailure)
            {
                throw new AggregateException(
                    "Desktop access grant and window-station rollback both failed.",
                    primaryFailure,
                    rollbackFailure);
            }
            throw;
        }
        return new RionDesktopAccessLease
        {
            WindowStationDescriptor = oldWindowStation,
            DesktopDescriptor = oldDesktop
        };
    }

    public static void Restore(RionDesktopAccessLease lease)
    {
        var failures = new List<Exception>();
        try
        {
            Write(GetThreadDesktop(GetCurrentThreadId()), lease.DesktopDescriptor);
        }
        catch (Exception error)
        {
            failures.Add(error);
        }
        try
        {
            Write(GetProcessWindowStation(), lease.WindowStationDescriptor);
        }
        catch (Exception error)
        {
            failures.Add(error);
        }
        if (failures.Count != 0)
        {
            throw new AggregateException(
                "Interactive desktop ACL restoration failed.",
                failures);
        }
    }

    private static byte[] Read(IntPtr handle)
    {
        uint needed;
        int requested = DaclSecurityInformation;
        GetUserObjectSecurity(handle, ref requested, null, 0, out needed);
        if (needed == 0)
        {
            throw new Win32Exception();
        }
        byte[] descriptor = new byte[needed];
        if (!GetUserObjectSecurity(handle, ref requested, descriptor, needed, out needed))
        {
            throw new Win32Exception();
        }
        return descriptor;
    }

    private static void Write(IntPtr handle, byte[] descriptor)
    {
        int requested = DaclSecurityInformation;
        if (!SetUserObjectSecurity(handle, ref requested, descriptor))
        {
            throw new Win32Exception();
        }
    }

    private static byte[] AddAllowAce(
        byte[] source,
        SecurityIdentifier sid,
        int mask)
    {
        var descriptor = new RawSecurityDescriptor(source, 0);
        if (descriptor.DiscretionaryAcl == null)
        {
            return source;
        }
        RawAcl dacl = descriptor.DiscretionaryAcl;
        dacl.InsertAce(dacl.Count, new CommonAce(
            AceFlags.None,
            AceQualifier.AccessAllowed,
            mask,
            sid,
            false,
            null));
        descriptor.DiscretionaryAcl = dacl;
        byte[] result = new byte[descriptor.BinaryLength];
        descriptor.GetBinaryForm(result, 0);
        return result;
    }
}
