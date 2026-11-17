// Separate integration-test process: actually attempts an NTFS junction rewrite.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
internal static class ReparseWriter
{
    static void Main(string[] args)
    {
        uint access = args[2] == "attributes" || args[2] == "remove" ? 0x100u : 0x40000000u;
        using (var handle = CreateFileW(args[0], access, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero))
        {
            if (handle.IsInvalid) { Console.Write("open_error:" + Marshal.GetLastWin32Error()); return; }
            if (args[2] == "remove")
            {
                byte[] deletion = new byte[] { 3, 0, 0, 160, 0, 0, 0, 0 }; uint returned;
                bool removed = DeviceIoControl(handle, 0x000900AC, deletion, (uint)deletion.Length, IntPtr.Zero, 0, out returned, IntPtr.Zero);
                Console.Write(removed ? "removed" : "io_error:" + Marshal.GetLastWin32Error()); return;
            }
            byte[] substitute = Encoding.Unicode.GetBytes("\\??\\" + Path.GetFullPath(args[1]));
            byte[] print = Encoding.Unicode.GetBytes(Path.GetFullPath(args[1]));
            using (var stream = new MemoryStream())
            using (var writer = new BinaryWriter(stream))
            {
                writer.Write(0xA0000003u); writer.Write((ushort)(8 + substitute.Length + print.Length + 4)); writer.Write((ushort)0);
                writer.Write((ushort)0); writer.Write((ushort)substitute.Length); writer.Write((ushort)(substitute.Length + 2)); writer.Write((ushort)print.Length);
                writer.Write(substitute); writer.Write((ushort)0); writer.Write(print); writer.Write((ushort)0); writer.Flush();
                byte[] data = stream.ToArray(); uint returned;
                bool success = DeviceIoControl(handle, 0x000900A4, data, (uint)data.Length, IntPtr.Zero, 0, out returned, IntPtr.Zero);
                Console.Write(success ? "set" : "io_error:" + Marshal.GetLastWin32Error());
            }
        }
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DeviceIoControl(SafeFileHandle handle, uint code, byte[] input, uint size, IntPtr output, uint outputSize, out uint returned, IntPtr overlapped);
}
