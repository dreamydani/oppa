use base64::prelude::*;

// Generates UTF-16LE Base64 bootstrap for PowerShell startup.

pub fn encode_powershell_command(command: &str) -> String {
    let utf16_bytes: Vec<u8> = command.encode_utf16().flat_map(|c| c.to_le_bytes()).collect();
    BASE64_STANDARD.encode(&utf16_bytes)
}

pub fn generate_powershell_bootstrap_text(initial_cwd: Option<&str>) -> String {
    let restore_cwd = match initial_cwd {
        Some(cwd) if !cwd.is_empty() => {
            let escaped = cwd.replace('\'', "''");
            format!("\ntry {{ Set-Location -LiteralPath '{escaped}' -ErrorAction Stop }} catch {{}}\n")
        }
        _ => String::new(),
    };

    format!(
r#"try {{
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
    [Console]::InputEncoding = [System.Text.UTF8Encoding]::new()
    $OutputEncoding = [Console]::OutputEncoding
}} catch {{}}
if ($ExecutionContext.SessionState.LanguageMode -eq "FullLanguage" -and (-not (Test-Path variable:global:__OppaOscState))) {{
    $Global:__OppaOscState = @{{
        OriginalPrompt = $function:prompt
        OriginalReadLine = $function:PSConsoleHostReadLine
        HasSeenPrompt = $false
        HasPSReadLine = $null -ne (Get-Module -Name PSReadLine)
        Esc = [char]27
        Bel = [char]7
    }}
    function Global:prompt {{
        $fakeExitCode = [int](!$global:?)
        Set-StrictMode -Off
        $result = ""
        if ($Global:__OppaOscState.HasSeenPrompt) {{
            $result += "$($Global:__OppaOscState.Esc)]133;D;$fakeExitCode$($Global:__OppaOscState.Bel)"
        }}
        $Global:__OppaOscState.HasSeenPrompt = $true
        $rawPath = $PWD.Path -replace '\\', '/'
        $result += "$($Global:__OppaOscState.Esc)]7;file://$($env:COMPUTERNAME)/$rawPath$($Global:__OppaOscState.Bel)"
        $result += "$($Global:__OppaOscState.Esc)]133;A$($Global:__OppaOscState.Bel)"
        if ($fakeExitCode -ne 0) {{ Write-Error "failure" -ea ignore }}
        $result += $Global:__OppaOscState.OriginalPrompt.Invoke()
        $result += "$($Global:__OppaOscState.Esc)]133;B$($Global:__OppaOscState.Bel)"
        $result
    }}
    if ($Global:__OppaOscState.HasPSReadLine -and $null -ne $Global:__OppaOscState.OriginalReadLine) {{
        function Global:PSConsoleHostReadLine {{
            $commandLine = $Global:__OppaOscState.OriginalReadLine.Invoke()
            [Console]::Write("$($Global:__OppaOscState.Esc)]133;C;$commandLine$($Global:__OppaOscState.Bel)")
            return $commandLine
        }}
    }}
    }}
[Console]::Write("$([char]27)]633;oppa-ready$([char]7)"){restore_cwd}"#
    )
}

pub fn generate_powershell_encoded_bootstrap(initial_cwd: Option<&str>) -> String {
    let script = generate_powershell_bootstrap_text(initial_cwd);
    encode_powershell_command(&script)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_powershell_command_utf16le_base64() {
        let cmd = "Write-Host 'Hello'";
        let encoded = encode_powershell_command(cmd);
        let utf16_bytes: Vec<u8> = cmd.encode_utf16().flat_map(|c| c.to_le_bytes()).collect();
        let expected = BASE64_STANDARD.encode(&utf16_bytes);
        assert_eq!(encoded, expected);
    }

    #[test]
    fn test_generate_powershell_encoded_bootstrap_contains_hooks() {
        let bootstrap = generate_powershell_bootstrap_text(Some("C:\\test\\dir"));
        assert!(bootstrap.contains("[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()"));
        assert!(bootstrap.contains("133;A"));
        assert!(bootstrap.contains("133;D"));
        assert!(bootstrap.contains("]7;file://"));
        assert!(bootstrap.contains("Set-Location -LiteralPath 'C:\\test\\dir'"));
    }

    #[test]
    fn test_bootstrap_emits_command_line_in_command_start() {
        let bootstrap = generate_powershell_bootstrap_text(None);
        assert!(bootstrap.contains("133;C;$commandLine"));
    }

    #[test]
    fn test_bootstrap_emits_ready_marker_exactly_once() {
        let bootstrap = generate_powershell_bootstrap_text(Some("C:\\test\\dir"));
        assert!(bootstrap.contains("633;oppa-ready"));
        assert_eq!(bootstrap.matches("633;oppa-ready").count(), 1);
        assert!(bootstrap.contains("Set-Location -LiteralPath 'C:\\test\\dir'"));
    }

    #[test]
    fn test_generate_powershell_encoded_bootstrap_roundtrip() {
        let encoded = generate_powershell_encoded_bootstrap(Some("C:\\test\\dir"));
        let decoded_bytes = BASE64_STANDARD.decode(&encoded).expect("valid base64");
        assert_eq!(decoded_bytes.len() % 2, 0);
        let u16_vec: Vec<u16> = decoded_bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect();
        let decoded_str = String::from_utf16(&u16_vec).expect("valid utf16");
        assert!(decoded_str.contains("Set-Location -LiteralPath 'C:\\test\\dir'"));
    }
}
