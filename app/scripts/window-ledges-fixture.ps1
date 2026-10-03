param([int]$ParentId,[int]$Left,[int]$Top)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class LegacyLedgeFixture {
    public delegate IntPtr WindowProcedure(IntPtr window,uint message,UIntPtr parameter,IntPtr value);
    static WindowProcedure procedure=DefWindowProcW;
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct WindowClass {
        public uint Size,Style; public IntPtr Procedure; public int ClassExtra,WindowExtra;
        public IntPtr Instance,Icon,Cursor,Background; public string Menu,Name; public IntPtr SmallIcon;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
    [StructLayout(LayoutKind.Sequential)] public struct Message {
        public IntPtr Hwnd; public uint Id; public UIntPtr WParam; public IntPtr LParam;
        public uint Time; public Point Pt; public uint Private;
    }
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr GetModuleHandleW(string name);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern ushort RegisterClassExW(ref WindowClass definition);
    [DllImport("user32.dll")] public static extern IntPtr DefWindowProcW(IntPtr window,uint message,UIntPtr parameter,IntPtr value);
    [DllImport("user32.dll",CharSet=CharSet.Unicode,ExactSpelling=true)]
    public static extern IntPtr CreateWindowExW(uint exStyle,string cls,string title,uint style,
        int x,int y,int width,int height,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr parameter);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window,int command);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool DestroyWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool PeekMessageW(out Message message,IntPtr window,uint min,uint max,uint remove);
    [DllImport("user32.dll")] public static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] public static extern IntPtr DispatchMessageW(ref Message message);
    [DllImport("user32.dll")] public static extern uint MsgWaitForMultipleObjects(uint count,IntPtr handles,bool all,uint timeout,uint wakeMask);
    public static void Run(int parentId,int x,int y) {
        if(SetThreadDpiAwarenessContext(new IntPtr(-1))==IntPtr.Zero)
            throw new Exception("无法设置独立 Legacy 进程的 DPI。");
        WindowClass cls=new WindowClass();
        cls.Size=(uint)Marshal.SizeOf(typeof(WindowClass));cls.Name="TTCatsLegacyFixture";
        cls.Procedure=Marshal.GetFunctionPointerForDelegate(procedure);
        cls.Instance=GetModuleHandleW(null);cls.Background=new IntPtr(6);
        if(RegisterClassExW(ref cls)==0) throw new Exception("无法注册独立 Legacy 标准窗口。");
        IntPtr window=CreateWindowExW(0x08000000,cls.Name,"TTCats M4 Legacy",0x00cf0000,
            x,y,600,400,IntPtr.Zero,IntPtr.Zero,cls.Instance,IntPtr.Zero);
        if(window==IntPtr.Zero) throw new Exception("无法创建独立 Legacy 回归窗口。");
        try {
            ShowWindow(window,4);
            Console.WriteLine("HWND:"+window.ToInt64()); Console.Out.Flush();
            Process parent=Process.GetProcessById(parentId);
            DateTime expires=DateTime.UtcNow.AddMinutes(10);
            while(IsWindow(window) && !parent.HasExited && DateTime.UtcNow<expires) {
                Message message;
                while(PeekMessageW(out message,IntPtr.Zero,0,0,1)) {
                    TranslateMessage(ref message); DispatchMessageW(ref message);
                }
                MsgWaitForMultipleObjects(0,IntPtr.Zero,false,100,0x4ff);
            }
        } finally { if(IsWindow(window)) DestroyWindow(window); }
    }
}
'@
[LegacyLedgeFixture]::Run($ParentId,$Left,$Top)
