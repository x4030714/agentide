//! Everything this process starts dies with it. An exit handler cannot help when the app is
//! killed, so a job object with `KILL_ON_JOB_CLOSE` does it; grandchildren join for free.

/// Take a child into the job, so it cannot outlive this process.
/// Long-lived spawns only; `git` and `explorer` exit on their own.
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
    /// Never closed: closing it is what kills the children, so the OS does it at exit.
    static JOB: OnceLock<usize> = OnceLock::new();

    pub fn init() {
        // The handle must not be inheritable: a copy in a child would keep the job alive
        // past our death and it would kill nothing -- a silent no-op.
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
            // A job without the limit is worse than none: it holds the children without
            // killing them and stops them joining a job that would.
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
        // Exactly the rights `AssignProcessToJobObject` needs; more would fail against a
        // child at a different integrity level.
        let child = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        if child.is_null() {
            eprintln!("[reaper] cannot open process {pid}; it may outlive the app");
            return;
        }
        let assigned = unsafe { AssignProcessToJobObject(job as HANDLE, child) };
        // Our handle to the child, not the child: process and job membership survive.

        unsafe { CloseHandle(child) };
        if assigned == 0 {
            eprintln!("[reaper] cannot adopt process {pid}; it may outlive the app");
        }
    }
}
