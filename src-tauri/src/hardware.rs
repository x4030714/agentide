//! How much video memory there is, so the local-model list can say what will fit.
//! `nvidia-smi` not WMI: `Win32_VideoController.AdapterRAM` is 32-bit and caps at 4 GB.

use std::process::Command;

use crate::ipc::IpcError;

/// Video memory in whole gigabytes, or `None` when there is no NVIDIA GPU to ask.
/// Rounded down: rounding up would promise room the desktop has already taken.
#[tauri::command]
pub async fn gpu_vram_gb() -> Result<Option<u32>, IpcError> {
    Ok(read_vram())
}

#[cfg(windows)]
fn read_vram() -> Option<u32> {
    /// Without this a console window flashes over the app at startup.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    use std::os::windows::process::CommandExt;

    let output = Command::new("nvidia-smi")
        .args(["--query-gpu=memory.total", "--format=csv,noheader,nounits"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    parse_vram(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(not(windows))]
fn read_vram() -> Option<u32> {
    let output = Command::new("nvidia-smi")
        .args(["--query-gpu=memory.total", "--format=csv,noheader,nounits"])
        .output()
        .ok()?;
    parse_vram(&String::from_utf8_lossy(&output.stdout))
}

/// The first line of `nvidia-smi`'s output, in mebibytes, as whole gigabytes.
/// First card only: splitting one model across two GPUs is a separate choice.
fn parse_vram(stdout: &str) -> Option<u32> {
    let line = stdout.lines().next()?.trim();
    let mib: u32 = line.parse().ok()?;
    // A card reports under its nominal size (8151 MiB for 8 GB), so this floors rather than
    // rounds. What is addressable is what matters.
    Some(mib / 1024)
}

#[cfg(test)]
mod tests {
    use super::parse_vram;

    #[test]
    fn an_eight_gigabyte_card_reports_what_it_can_actually_hold() {
        // An RTX 5060 Ti reports 8151 MiB; calling that 8 promises a gigabyte that is gone.
        assert_eq!(parse_vram("8151\n"), Some(7));
    }

    #[test]
    fn a_large_card_is_not_truncated_the_way_wmi_truncates_it() {
        assert_eq!(parse_vram("24564\n"), Some(23));
    }

    #[test]
    fn only_the_first_card_is_read() {
        assert_eq!(parse_vram("8151\n8151\n"), Some(7));
    }

    #[test]
    fn no_nvidia_tool_and_no_output_is_not_a_failure() {
        assert_eq!(parse_vram(""), None);
        assert_eq!(parse_vram("\n"), None);
    }

    #[test]
    fn anything_unparseable_is_absent_rather_than_guessed() {
        // A driver error prints prose to stdout; guessing from it would list a model that
        // cannot run.
        assert_eq!(parse_vram("NVIDIA-SMI has failed because..."), None);
    }
}
