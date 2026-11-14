// Windows 10+ trusted-host process lifetime supervision, not a security sandbox.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class ProcessSupervisor
{
    private static readonly object OutputLock = new object();
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };
    private static int stopReason;

    public sealed class Request
    {
        public int version { get; set; }
        public string command { get; set; }
        public string[] args { get; set; }
        public string cwd { get; set; }
        public string input { get; set; }
        public int timeoutMs { get; set; }
        public int outputLimit { get; set; }
    }

    private static void Send(object message)
    {
        lock (OutputLock) { Console.Out.WriteLine(Json.Serialize(message)); Console.Out.Flush(); }
    }
    private static string ReadLine(int maximum)
    {
        var line = new StringBuilder();
        int ch;
        while ((ch = Console.In.Read()) != -1 && ch != '\n')
        {
            if (line.Length >= maximum) throw new InvalidDataException("Control message exceeds limit");
            line.Append((char)ch);
        }
        return ch == -1 && line.Length == 0 ? null : line.ToString();
    }
    private static void Check(bool success, string operation)
    {
        if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
    private static void Close(ref IntPtr handle)
    {
        if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; }
    }
    // Microsoft CRT argv quoting; lpApplicationName is separately specified.
    private static string Quote(string value)
    {
        var text = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            text.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            text.Append(c);
            slashes = 0;
        }
        text.Append('\\', slashes * 2);
        return text.Append('"').ToString();
    }
    private static Thread Background(ThreadStart action)
    {
        var thread = new Thread(action) { IsBackground = true };
        thread.Start();
        return thread;
    }

    public static int Main()
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        IntPtr job = IntPtr.Zero, inputRead = IntPtr.Zero, inputWrite = IntPtr.Zero;
        IntPtr outputRead = IntPtr.Zero, outputWrite = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero, handles = IntPtr.Zero, jobs = IntPtr.Zero;
        bool attributesReady = false, created = false, resumed = false;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        try
        {
            var line = ReadLine(8 * 1024 * 1024);
            if (line == null) return 0;
            var request = Json.Deserialize<Request>(line);
            if (request.version != 1 || string.IsNullOrEmpty(request.command) || request.args == null ||
                request.timeoutMs < 1 || request.outputLimit < 1 || request.outputLimit > 4 * 1024 * 1024)
                throw new InvalidDataException("Invalid supervisor request");
            byte[] input = Convert.FromBase64String(request.input ?? "");
            Background(delegate {
                try {
                    // One stop message or EOF both revoke this process call's lifetime.
                    ReadLine(128);
                    Interlocked.CompareExchange(ref stopReason, 1, 0);
                } catch { Interlocked.CompareExchange(ref stopReason, 1, 0); }
            });

            job = CreateJobObjectW(IntPtr.Zero, null);
            Check(job != IntPtr.Zero, "CreateJobObject");
            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE, no breakaway
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)), "SetInformationJobObject");
            var security = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = true };
            Check(CreatePipe(out inputRead, out inputWrite, ref security, 0), "CreatePipe stdin");
            Check(CreatePipe(out outputRead, out outputWrite, ref security, 0), "CreatePipe output");
            Check(SetHandleInformation(inputWrite, 1, 0), "Protect stdin writer");
            Check(SetHandleInformation(outputRead, 1, 0), "Protect output reader");

            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            attributes = Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref size), "Initialize process attributes");
            attributesReady = true;
            handles = Marshal.AllocHGlobal(IntPtr.Size * 2);
            Marshal.WriteIntPtr(handles, 0, inputRead);
            Marshal.WriteIntPtr(handles, IntPtr.Size, outputWrite);
            Check(UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x20002, handles, (IntPtr)(IntPtr.Size * 2), IntPtr.Zero, IntPtr.Zero), "Limit inherited handles");
            jobs = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobs, job);
            // Assign at creation: no created-but-unassigned interval if the supervisor dies.
            Check(UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x2000D, jobs, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero), "Assign creation-time job");
            var startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = Marshal.SizeOf(startup);
            startup.StartupInfo.dwFlags = 0x100; // STARTF_USESTDHANDLES
            startup.StartupInfo.hStdInput = inputRead;
            startup.StartupInfo.hStdOutput = startup.StartupInfo.hStdError = outputWrite;
            startup.lpAttributeList = attributes;
            var commandLine = new StringBuilder(Quote(request.command));
            foreach (string arg in request.args) commandLine.Append(' ').Append(Quote(arg));
            Check(CreateProcessW(request.command, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                0x08000000 | 0x00080000 | 0x4, IntPtr.Zero, request.cwd, ref startup, out process), "Create contained process");
            created = true;
            Close(ref inputRead);
            Close(ref outputWrite);
            var inputStream = new FileStream(new SafeFileHandle(inputWrite, true), FileAccess.Write);
            inputWrite = IntPtr.Zero;
            var outputStream = new FileStream(new SafeFileHandle(outputRead, true), FileAccess.Read);
            outputRead = IntPtr.Zero;
            Background(delegate {
                using (inputStream) { try { inputStream.Write(input, 0, input.Length); } catch (IOException) { } }
            });
            var reader = Background(delegate {
                using (outputStream) {
                    try {
                        var buffer = new byte[4096];
                        int count, emitted = 0;
                        while ((count = outputStream.Read(buffer, 0, buffer.Length)) > 0) {
                            int send = Math.Min(count, Math.Max(0, request.outputLimit + 1 - emitted));
                            if (send > 0) Send(new { version = 1, type = "output", data = Convert.ToBase64String(buffer, 0, send) });
                            emitted += send;
                            if (emitted > request.outputLimit) Interlocked.CompareExchange(ref stopReason, 2, 0);
                        }
                    } catch (IOException) { Interlocked.CompareExchange(ref stopReason, 1, 0); }
                }
            });
            Send(new { version = 1, type = "started", pid = process.dwProcessId });
            if (Volatile.Read(ref stopReason) == 0) {
                Check(ResumeThread(process.hThread) != uint.MaxValue, "Resume contained process");
                resumed = true;
            }
            var clock = Stopwatch.StartNew();
            while (Volatile.Read(ref stopReason) == 0) {
                uint status = WaitForSingleObject(process.hProcess, 20);
                if (status == 0) break;
                Check(status == 258, "Wait for root process");
                if (clock.ElapsedMilliseconds >= request.timeoutMs) Interlocked.CompareExchange(ref stopReason, 3, 0);
            }
            uint exitCode;
            Check(GetExitCodeProcess(process.hProcess, out exitCode), "Read root exit code");
            // Always retire descendants when root completes; no background process outlives a call.
            Check(TerminateJobObject(job, 1), "Terminate job");
            var drain = Stopwatch.StartNew();
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
            do {
                Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero), "Query active processes");
                if (accounting.ActiveProcesses == 0) break;
                Thread.Sleep(10);
            } while (drain.ElapsedMilliseconds < 3000);
            bool confirmed = accounting.ActiveProcesses == 0;
            if (confirmed) {
                Check(GetExitCodeProcess(process.hProcess, out exitCode), "Read final exit code");
                if (!reader.Join(1000)) throw new IOException("Output pipe did not close after job drain");
            }
            int why = Volatile.Read(ref stopReason);
            Send(new { version = 1, type = "receipt", pid = process.dwProcessId, confirmed,
                activeProcesses = accounting.ActiveProcesses, exitCode = confirmed ? (long?)exitCode : null,
                reason = why == 2 ? "output_limit" : why == 3 ? "timeout" : why == 1 ? "aborted" : null });
            return confirmed ? 0 : 2;
        }
        catch (Exception error)
        {
            try { Send(new { version = 1, type = "error", started = resumed, created,
                message = error.Message, win32Code = error is Win32Exception ? ((Win32Exception)error).NativeErrorCode : 0 }); }
            catch { /* Owner already disconnected. Closing the last job handle still kills members. */ }
            return 1;
        }
        finally
        {
            // The job handle was never inheritable or handed to the target.
            Close(ref job);
            Close(ref process.hThread); Close(ref process.hProcess);
            Close(ref inputRead); Close(ref inputWrite); Close(ref outputRead); Close(ref outputWrite);
            if (attributesReady) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if (jobs != IntPtr.Zero) Marshal.FreeHGlobal(jobs);
        }
    }

    [StructLayout(LayoutKind.Sequential)] private struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct STARTUPINFO {
        public int cb; public string lpReserved, lpDesktop, lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] private struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)] private struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] private struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int info, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION data, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(IntPtr job, int info, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION data, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool CreateProcessW(string app, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
}
