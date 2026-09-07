//! What the machine can run, for the local-model list.
//!
//! One question only: how much video memory is there. That decides which models fit
//! entirely on the GPU, which will spill into system RAM and run slowly, and which are not
//! worth downloading at all — a distinction worth making before seventeen gigabytes rather
//! than after.
//!
//! `nvidia-smi` rather than WMI, because WMI is wrong. `Win32_VideoController.AdapterRAM`
//! is a 32-bit field and reports 4 GB for every card above that, which on this machine
//! turns an 8 GB card into a 4 GB one and would hide half the list for no reason.
//!
//! Absent is not an error. No NVIDIA card, or no driver, means llama.cpp runs on the CPU;
//! the UI says what that costs rather than refusing.

use std::process::Command;

use crate::ipc::IpcError;

/// Video memory in whole gigabytes, or `None` when there is no NVIDIA GPU to ask.
///
/// Rounded down: the number is used to decide whether a model fits, and rounding up would
/// promise room that is not there. The card also never has all of it free — a desktop uses
/// some — which the caller's own headroom allowance covers.
#[tauri::command]
pub async fn gpu_vram_gb() -> Result<Option<u32>, IpcError> {
    Ok(read_vram())
}

#[cfg(windows)]
fn read_vram() -> Option<u32> {
    /// Keeps the console window from flashing up. This runs at startup, and a black
    /// rectangle appearing over the app for a frame is the kind of detail that reads as
    /// broken.
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
///
/// The first card only. A second GPU does not add usable memory for one model — llama.cpp
/// can split across them, but that is a choice with its own costs and not one to make on
/// the strength of a number nobody was shown.
fn parse_vram(stdout: &str) -> Option<u32> {
    let line = stdout.lines().next()?.trim();
    let mib: u32 = line.parse().ok()?;
    // A card reports slightly under its nominal size — 8151 MiB for an 8 GB card — so this
    // divides rather than rounds to the nearest, and 8151 becomes 7. Deliberate: what is
    // addressable is what matters, and it is always less than the number on the box.
    Some(mib / 1024)
}

#[cfg(test)]
mod tests {
    use super::parse_vram;

    #[test]
    fn an_eight_gigabyte_card_reports_what_it_can_actually_hold() {
        // 8151 MiB is what an RTX 5060 Ti reports. Calling that 8 would promise a
        // gigabyte that is not there once the desktop has its share.
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
        // A driver error prints prose to stdout. Guessing a number from it would put a
        // model on the list that cannot run.
        assert_eq!(parse_vram("NVIDIA-SMI has failed because..."), None);
    }
}
