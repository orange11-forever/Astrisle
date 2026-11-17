// Real writable file mapping kept alive after the original file handle closes.
using System;
using System.IO;
using System.IO.MemoryMappedFiles;
using System.Text;
internal static class MappedWriter
{
    static void Main(string[] args)
    {
        using (var stream = new FileStream(args[0], FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite | FileShare.Delete))
        using (var map = MemoryMappedFile.CreateFromFile(stream, null, 0, MemoryMappedFileAccess.ReadWrite, null, HandleInheritability.None, true))
        {
            stream.Dispose();
            MemoryMappedViewAccessor view = args.Length > 1 && args[1] == "section" ? null : map.CreateViewAccessor();
            try
            {
                Console.WriteLine("ready"); Console.Out.Flush();
                string input = Console.ReadLine();
                if (input == "edit")
                {
                    if (view == null) view = map.CreateViewAccessor();
                    byte[] bytes = Encoding.UTF8.GetBytes("user000"); view.WriteArray(0, bytes, 0, bytes.Length); view.Flush();
                }
            }
            finally { if (view != null) view.Dispose(); }
        }
    }
}
