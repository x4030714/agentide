//! Everything this process starts dies with it.
//!
//! agentide spawns three kinds of long-lived child -- the agent host, a language server
//! per workspace, and a shell per terminal -- and each of them spawns more: the host
//! starts the Claude CLI, which starts an MCP server per configured entry. None of that
//! is reachable from an exit handler, because the case that matters is the one where no
//! handler runs. Measured on this machine in a single evening: a rust-analyzer holding
//! 1 GB from the night before, and a 2.1 GB `vite build` from a run that had already
//! died. Between them they were most of the reason the app was killed for low memory
//! three times, which then orphaned more.
//!
//! `lib.rs` already has an exit handler and it did not help, because a process killed by
//! taskkill or by the OS for memory pressure does not get to run code. So the guarantee
//! has to come from the kernel rather than from us: a job object with
//! `KILL_ON_JOB_CLOSE` kills every member the moment the last handle to the job closes,
//! and process death closes handles whatever the cause.
//!
//! Grandchildren come along for free. A process created by a job member joins that member's
//! job automatically, so assigning the agent host also covers the CLI it starts and every
//! MCP server that CLI starts -- which is the part an exit handler could never have found,
//! since nothing here knows those processes exist.
//!
//! Nothing here is fatal. A job that cannot be created, or a child that cannot be assigned,
//! leaves exactly the behaviour that existed before this module: an orphan.

/// Take a child into the job, so it cannot outlive this process.
///
/// Called after every spawn that produces something long-lived. Short-lived commands --
/// `git`, `explorer` -- are left alone: they exit on their own, and a failed assignment
/// would be noise about a process that is already gone.
pub fn adopt(pid: u32) {
    #[cfg(windows)]
    windows::adopt(pid);
    #[cfg(not(windows))]
    let _ = pid;
}

/// Create the job. Call once, from `setup`, before anything is spawned.
pub fn init() {
    #[cfg(windows)]
    windows::init();
}

#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    use std::sync::OnceLock;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    /// The job, as a `usize` because a raw `HANDLE` is a pointer and therefore not `Sync`.
    ///
    /// Never closed. Closing it is precisely what kills the children, so the only correct
    /// time is process exit -- which the OS does for us, and which is the whole mechanism.
    static JOB: OnceLock<usize> = OnceLock::new();

    pub fn init() {
        // Unnamed, and the handle is not inheritable: a second handle living in a child
        // would keep the job alive after this process died, and the job would then kill
        // nothing. That is the one mistake that turns this module into a no-op while
        // looking like it works.
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            eprintln!("[reaper] no job object; children may outlive the app");
            return;
        }

        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let set = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits).cast::<c_void>(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if set == 0 {
            // A job without the limit would hold the children without killing them, which
            // is worse than none: it would also stop them joining a job that does.
            eprintln!("[reaper] the job would not take kill-on-close; children may outlive the app");
            unsafe { CloseHandle(job) };
            return;
        }

        let _ = JOB.set(job as usize);
    }

    pub fn adopt(pid: u32) {
        let Some(&job) = JOB.get() else {
            return;
        };
        // Exactly the two rights `AssignProcessToJobObject` needs. Asking for more would
        // fail against a child running at a different integrity level for no gain.
        let child = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        if child.is_null() {
            eprintln!("[reaper] cannot open process {pid}; it may outlive the app");
            return;
        }
        let assigned = unsafe { AssignProcessToJobObject(job as HANDLE, child) };
        // Our handle to the child, not the child: closing it leaves the process running
        // and the job membership intact.
        unsafe { CloseHandle(child) };
        if assigned == 0 {
            eprintln!("[reaper] cannot adopt process {pid}; it may outlive the app");
        }
    }
}
