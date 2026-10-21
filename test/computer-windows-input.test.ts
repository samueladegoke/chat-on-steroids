import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HELPER_SCRIPT } from '../src/main/computer/helper.js';

describe.runIf(process.platform === 'win32')('compiled Windows input failure recovery', () => {
  it('releases partial input, distinguishes extended keys, and rechecks each coordinate action', () => {
    // Compile the real embedded C# and execute the real PowerShell dispatcher, replacing
    // only OS input/system-metric entry points. No input reaches any user window.
    const nativeSend = /\[DllImport\("user32.dll", SetLastError = true\)\]\s*static extern uint SendInput\(uint n, INPUT\[\] inputs, int size\);/;
    expect(HELPER_SCRIPT).toMatch(nativeSend);
    const script = HELPER_SCRIPT.slice(0, HELPER_SCRIPT.indexOf('while (($line = [Console]::In.ReadLine())'))
      .replace(nativeSend, `
  public static List<string> TestEvents = new List<string>();
  public static List<string> TestMoves = new List<string>();
  public static List<int> TestWheels = new List<int>();
  public static int TestFailCall, TestCalls;
  public static long TestForeignRoot;
  public static void TestReset(int failCall) { TestEvents.Clear(); TestMoves.Clear(); TestWheels.Clear(); TestCalls = 0; TestFailCall = failCall; }
  static uint SendInput(uint n, INPUT[] inputs, int size) {
    TestCalls++;
    foreach (INPUT i in inputs) TestEvents.Add(i.type == INPUT_MOUSE ? "mouse:" + i.u.mi.dwFlags : (i.u.ki.dwFlags & 4) != 0 ? "text:" + i.u.ki.wScan + ":" + i.u.ki.dwFlags : "key:" + i.u.ki.wVk + ":" + i.u.ki.dwFlags);
    foreach (INPUT i in inputs) if (i.type == INPUT_MOUSE && (i.u.mi.dwFlags & 1) != 0) TestMoves.Add(i.u.mi.dx + "," + i.u.mi.dy);
    foreach (INPUT i in inputs) if (i.type == INPUT_MOUSE && (i.u.mi.dwFlags & 0x1800) != 0) TestWheels.Add(unchecked((int)i.u.mi.mouseData));
    return TestCalls == TestFailCall ? n - 1 : n;
  }`)
      .replace('[DllImport("user32.dll")] static extern int GetSystemMetrics(int index);',
        'static int GetSystemMetrics(int index) { return index == 78 || index == 79 ? 1000 : 0; }')
      .replace('public static long ForeignInputRoot(long handle) {',
        'public static long ForeignInputRoot(long handle) {\n    if (TestForeignRoot != 0) return TestForeignRoot;')
      // The production guard is exercised after Move, but the synthetic Win32
      // receiver is controlled: this test must never depend on the user's live
      // foreground app or pointer capture while OS SendInput is stubbed.
      .replace('static void GuardPointerReceiver(long target, int x, int y) {',
        'public static bool TestPointerAllowed = true;\n  static void GuardPointerReceiver(long target, int x, int y) {')
      .replace('(!InputIsFocused(target) || !HitTargetsWindow(target, x, y))', '!TestPointerAllowed');
    const assertions = String.raw`
[Clf]::TestReset(3)
try { [Clf]::Drag([int[]]@(1,2), [int[]]@(1,2), 'left'); throw 'drag unexpectedly succeeded' } catch {
  if ($_.Exception.Message -notmatch 'SendInput was blocked') { throw }
}
if ([Clf]::TestEvents[[Clf]::TestEvents.Count - 1] -ne 'mouse:4') { throw 'drag did not release after move failure' }
[Clf]::TestReset(0)
[Clf]::Drag([int[]]@(0,999), [int[]]@(0,999), 'left', 50)
if ([Clf]::TestMoves.Count -le 2 -or [Clf]::TestMoves[0] -ne '0,0' -or [Clf]::TestMoves[[Clf]::TestMoves.Count - 1] -ne '65535,65535' -or [Clf]::TestEvents[[Clf]::TestEvents.Count - 1] -ne 'mouse:4') { throw 'two-point drag did not interpolate to exact endpoint and release' }
[Clf]::TestReset(0)
[Clf]::Click(1,1,'left',3)
if (@([Clf]::TestEvents | Where-Object { $_ -eq 'mouse:2' }).Count -ne 3 -or @([Clf]::TestEvents | Where-Object { $_ -eq 'mouse:4' }).Count -ne 3) { throw 'triple click did not emit three pairs' }
[Clf]::TestReset(1)
try { [Clf]::Press([int[]]@(17,83)); throw 'chord unexpectedly succeeded' } catch {
  if ($_.Exception.Message -notmatch 'SendInput was blocked') { throw }
}
if (([Clf]::TestEvents -join ',') -ne 'key:17:0,key:83:0,key:83:2,key:17:2') { throw 'partial chord not released in reverse order' }
[Clf]::TestReset(2)
try { [Clf]::Click(1,1,'left',1); throw 'click unexpectedly succeeded' } catch {
  if ($_.Exception.Message -notmatch 'SendInput was blocked') { throw }
}
if ([Clf]::TestEvents[[Clf]::TestEvents.Count - 1] -ne 'mouse:4') { throw 'partial click not released' }
[Clf]::TestReset(0)
[Clf]::Press([int[]]@(17,65573))
if (([Clf]::TestEvents -join ',') -ne 'key:17:0,key:37:1,key:37:3,key:17:2') { throw 'extended key flags wrong' }
[Clf]::TestReset(0)
[Clf]::Scroll(1,1,2,-3,$true)
if (([Clf]::TestWheels -join ',') -ne '3,2') { throw 'raw wheel units changed' }
[Clf]::TestReset(0)
[Clf]::Scroll(1,1,2,-3)
if (([Clf]::TestWheels -join ',') -ne '360,240') { throw 'detent wheel units changed' }
[Clf]::TestReset(0)
try { [Clf]::Type("a\nb\r\nc".Replace('\r', [string][char]13).Replace('\n', [string][char]10)); throw 'multiline unexpectedly accepted' } catch {
  if ($_.Exception.Message -notmatch 'MULTILINE_REQUIRES_PASTE') { throw }
}
if ([Clf]::TestCalls -ne 0) { throw 'multiline rejection applied partial text' }
[Clf]::Type('ab')
if (([Clf]::TestEvents -join ',') -ne 'text:97:4,text:97:6,text:98:4,text:98:6') { throw 'single line Unicode typing failed' }
[Clf]::TestReset(1)
try { [Clf]::Type('ab'); throw 'partial text unexpectedly succeeded' } catch {
  if ($_.Exception.Message -notmatch 'SendInput was blocked') { throw }
}
if (([Clf]::TestEvents -join ',') -ne 'text:97:4,text:97:6,text:98:4,text:98:6,text:97:6,text:98:6') { throw 'partial Unicode packets not released' }
$script:checks = 0
$script:focuses = @()
function Assert-Focused([int64]$id) { $script:focuses += $id }
function Assert-PhysicalHit([int64]$id, [int]$x, [int]$y) { }
# Earlier PowerShell preflight may pass, then pointer movement opens a foreign
# overlay. The native guard MUST refuse the button/wheel/down with no such event
# entering SendInput; only a harmless pointer MOVE may already have happened.
foreach ($type in @('click','scroll','drag')) {
  [Clf]::TestReset(0)
  [Clf]::TestPointerAllowed = $false
  $request = switch ($type) {
    click { '{"op":"act","targetWindow":42,"frame":{"id":1},"actions":[{"type":"click","x":10,"y":20}]}' | ConvertFrom-Json }
    scroll { '{"op":"act","targetWindow":42,"frame":{"id":1},"actions":[{"type":"scroll","x":10,"y":20,"scroll_y":1}]}' | ConvertFrom-Json }
    drag { '{"op":"act","targetWindow":42,"frame":{"id":1},"actions":[{"type":"drag","xs":[10,900],"ys":[20,30],"durationMs":50}]}' | ConvertFrom-Json }
  }
  $result = Handle-Request $request
  if ($result.ok -ne $false -or $result.error_code -ne 'OCCLUDED_TARGET' -or $result.completed_count -ne 0 -or
      @([Clf]::TestEvents | Where-Object { $_ -match '^mouse:(2|4|8|16|32|64|2048|4096)$' }).Count -ne 0) {
    throw ('POST_MOVE_RECEIVER_REDIRECT_APPLIED_INPUT: ' + $type)
  }
}
[Clf]::TestPointerAllowed = $true
function Assert-CoordinateFrame($frame) {
  if ($script:focuses.Count -ne $script:checks) { throw 'frame focus occurred before ownership validation' }
  $script:checks++
  if ($script:checks -eq 2) { throw 'STALE_FRAME: changed after first action' }
  Assert-Focused ([int64]$request.targetWindow)
}
[Clf]::TestReset(0)
$request = '{"op":"act","targetWindow":42,"frame":{"id":1},"actions":[{"type":"move","x":1,"y":1},{"type":"move","x":2,"y":2}]}' | ConvertFrom-Json
$result = Handle-Request $request
if ($result.ok -ne $false -or $result.completed_count -ne 1 -or $result.failed_index -ne 1 -or $result.error_code -ne 'STALE_FRAME' -or [Clf]::TestCalls -ne 1) {
  throw 'per-action stale frame did not preserve exact partial result'
}
if (($script:focuses -join ',') -ne '42') { throw 'stale second frame focused target before native owner validation' }
# Identity/foreground can remain valid while a nonactivating popup covers input pixels.
# Reject that hit before sending a single pointer event.
function Assert-CoordinateFrame($frame) { Assert-Focused ([int64]$request.targetWindow) }
function Assert-PhysicalHit([int64]$id, [int]$x, [int]$y) { throw 'OCCLUDED_TARGET: another window receives the pointer' }
[Clf]::TestReset(0)
$request = '{"op":"act","targetWindow":42,"frame":{"id":1},"actions":[{"type":"click","x":1,"y":1}]}' | ConvertFrom-Json
$result = Handle-Request $request
if ($result.ok -ne $false -or $result.error_code -ne 'OCCLUDED_TARGET' -or $result.completed_count -ne 0 -or [Clf]::TestCalls -ne 0) {
  throw 'occluded coordinates were injected into a different window'
}
function Assert-PhysicalHit([int64]$id, [int]$x, [int]$y) { }
# A drag starts in a verified target window but may end in another application.
# Only its pointer-down pixel is subject to the starting window's physical-hit gate.
$script:checkedDragPoints = @()
function Assert-PhysicalHit([int64]$id, [int]$x, [int]$y) {
  $script:checkedDragPoints += "$x,$y"
  if ($x -ne 10) { throw 'OCCLUDED_TARGET: drag end incorrectly attributed to source window' }
}
[Clf]::TestReset(0)
$request = '{"op":"act","targetWindow":42,"frame":{"id":1},"actions":[{"type":"drag","xs":[10,900],"ys":[20,30],"button":"left","durationMs":50}]}' | ConvertFrom-Json
$result = Handle-Request $request
if ($result.ok -ne $true -or $result.completed_count -ne 1 -or ($script:checkedDragPoints -join ',') -ne '10,20' -or [Clf]::TestCalls -eq 0) {
  throw ('CROSS_WINDOW_DRAG_REFUSED_OR_RECHECKED_DESTINATION: ' + ($result | ConvertTo-Json -Compress))
}
Write-Output 'CROSS_WINDOW_DRAG_STARTED_WITH_VERIFIED_POINTER_DOWN'
function Assert-PhysicalHit([int64]$id, [int]$x, [int]$y) { }
# Also reject a stale FIRST frame with zero activation or OS input.
function Assert-CoordinateFrame($frame) { throw 'STALE_FRAME: process incarnation changed before focus' }
$script:focuses = @()
[Clf]::TestReset(0)
$request = '{"op":"act","targetWindow":42,"frame":{"id":1},"actions":[{"type":"click","x":1,"y":1}]}' | ConvertFrom-Json
$result = Handle-Request $request
if ($result.ok -ne $false -or $result.error_code -ne 'STALE_FRAME' -or $script:focuses.Count -ne 0 -or [Clf]::TestCalls -ne 0) {
  throw 'stale first frame focused or injected input before rejection'
}
[Clf]::TestReset(0)
$request = '{"op":"act","frame":{"id":1},"actions":[{"type":"move","x":1,"y":1},{"type":"keypress","keys":["not-a-key"]}]}' | ConvertFrom-Json
try { $null = Handle-Request $request; throw 'invalid key unexpectedly accepted' } catch {
  if ($_.Exception.Message -notmatch 'BAD_KEY') { throw }
}
if ([Clf]::TestCalls -ne 0) { throw 'invalid key applied earlier actions' }
$aliases = [CosWindowsKeys]::ResolveForLayout([string[]]@('Control_L','Control_R','Prior','KP_5'), [IntPtr]::Zero, [Func[char,IntPtr,int16]]{ param($char, $layout) return 0 })
if (($aliases -join ',') -ne '162,65699,65569,101') { throw ('keysym normalization failed: ' + ($aliases -join ',')) }
function Get-WindowRow([int64]$id) { return @{ id = $id; title = 'Owned fixture'; app = 'fixture.exe'; processId = 101; processPath = 'C:\Apps\fixture.exe'; processStartTime = '133000000000000101' } }
function Capture-Target($request, $forcedWindow) { return @{ width = 10; height = 10; captureMode = 'window' } }
function Find-UiElements($request) { throw 'UIA_FAILED: fixture provider unavailable' }
$request = '{"op":"snapshot","id":42,"includeScreenshot":true,"includeUi":true}' | ConvertFrom-Json
$result = Handle-Request $request
if ($result.ok -ne $true -or $result.width -ne 10 -or $result.uiUnavailable.code -ne 'UIA_FAILED') { throw 'accessibility failure discarded screenshot' }
function Capture-Target($request, $forcedWindow) { throw 'CAPTURE_FAILED: target window is minimized' }
function Find-UiElements($request) { return @{ snapshotId = 4; elements = @(@{name='Available control'}); visited=1; truncated=$false } }
$result = Handle-Request $request
if ($result.ok -ne $true -or $result.screenshotUnavailable.code -ne 'CAPTURE_FAILED' -or $result.elements[0].name -ne 'Available control' -or $result.width) { throw 'pixel failure discarded usable accessibility or invented pixels' }
$request.includeScreenshot = $true; $request.includeUi = $false
try { $null = Handle-Request $request; throw 'screenshot-only failure was hidden' } catch {
  if ($_.Exception.Message -notmatch '^CAPTURE_FAILED:') { throw }
}
$request.includeUi = $true
function Capture-Target($request, $forcedWindow) { throw 'STALE_FRAME: changed geometry' }
try { $null = Handle-Request $request; throw 'stale geometry was hidden' } catch {
  if ($_.Exception.Message -notmatch '^STALE_FRAME:') { throw }
}
function Capture-Target($request, $forcedWindow) { throw 'CAPTURE_FAILED: no pixels' }
function Find-UiElements($request) { throw 'provider unavailable' }
try { $null = Handle-Request $request; throw 'two unavailable channels were presented as success' } catch {
  if ($_.Exception.Message -notmatch 'CAPTURE_FAILED:.*UIA_FAILED:') { throw }
}
# A Window2 preflight proved A, but B may reuse the HWND before this native action.
# No keyboard injection or even focus is allowed after that replacement.
function Get-WindowRow([int64]$id) { return @{ id=$id; title='Replaced owner'; app='fixture.exe'; processId=101; processPath='C:\Apps\fixture.exe'; processStartTime='133000000000000202' } }
$script:focuses = @()
[Clf]::TestReset(0)
$request = '{"op":"act","targetWindow":42,"targetApp":"fixture.exe","expectedProcessStartTime":"133000000000000101","actions":[{"type":"type","text":"unsafe"}]}' | ConvertFrom-Json
$result = Handle-Request $request
if ($result.ok -ne $false -or $result.error_code -ne 'STALE_WINDOW' -or $script:focuses.Count -ne 0 -or [Clf]::TestCalls -ne 0) {
  throw 'recycled process received input or focus after a validated facade preflight'
}
# Keys for a no-activate popup reach its input root. When that root belongs to another
# process, the popup's own incarnation proves nothing about it: refuse before focus or keys.
function Assert-InputOwner([int64]$target, $owner, $targetApp, $ownerApp) { }
[Clf]::TestForeignRoot = 77
foreach ($json in @(
  '{"op":"act","targetWindow":42,"actions":[{"type":"type","text":"x"}]}',
  '{"op":"act","targetWindow":42,"ownerWindow":77,"actions":[{"type":"type","text":"x"}]}',
  '{"op":"act","targetWindow":42,"ownerWindow":78,"expectedOwnerProcessStartTime":"133000000000000202","actions":[{"type":"type","text":"x"}]}',
  '{"op":"act","actions":[{"type":"focus","window":42}]}')) {
  $script:focuses = @()
  [Clf]::TestReset(0)
  $result = Handle-Request ($json | ConvertFrom-Json)
  if ($result.ok -ne $false -or $result.error_code -ne 'STALE_WINDOW' -or $script:focuses.Count -ne 0 -or [Clf]::TestCalls -ne 0) {
    throw ('FOREIGN_INPUT_ROOT_RECEIVED_INPUT: ' + $json)
  }
}
$script:focuses = @()
[Clf]::TestReset(0)
$result = Handle-Request ('{"op":"act","targetWindow":42,"ownerWindow":77,"expectedOwnerProcessStartTime":"133000000000000202","actions":[{"type":"type","text":"x"}]}' | ConvertFrom-Json)
if ($result.ok -ne $true -or ($script:focuses -join ',') -ne '42' -or [Clf]::TestCalls -eq 0) {
  throw ('PROVEN_POPUP_OWNER_REFUSED: ' + ($result | ConvertTo-Json -Compress))
}
[Clf]::TestForeignRoot = 0
# Owner identity must be checked before and after a distinct popup capture,
# even if its HWND still appears related and its process matches its old row.
function Get-WindowRow([int64]$id) {
  $time = if ($id -eq 77) { '133000000000000202' } else { '133000000000000101' }
  return @{ id=$id; app='fixture.exe'; processId=101; processPath='C:\Apps\fixture.exe'; processStartTime=$time }
}
$script:didCapture = 0
function Capture-Target($request, $forcedWindow) { $script:didCapture++; return @{ width=10; height=10 } }
try {
  $null = Handle-Request ('{"op":"capture","id":42,"ownerWindow":77,"expectedOwnerProcessStartTime":"133000000000000101"}' | ConvertFrom-Json)
  throw 'PARENT_REPLACEMENT_WAS_ACCEPTED'
} catch { if ($_.Exception.Message -notmatch 'STALE_FRAME:') { throw } }
if ($script:didCapture -ne 0) { throw 'PARENT_REPLACEMENT_RAN_CAPTURE' }
$script:parentNow = '133000000000000101'
function Get-WindowRow([int64]$id) {
  return @{ id=$id; app='fixture.exe'; processId=101; processPath='C:\Apps\fixture.exe'; processStartTime= $(if ($id -eq 77) { $script:parentNow } else { '133000000000000101' }) }
}
function Capture-Target($request, $forcedWindow) {
  $script:parentNow = '133000000000000202'
  return @{ width=10; height=10 }
}
try {
  $null = Handle-Request ('{"op":"capture","id":42,"ownerWindow":77,"expectedOwnerProcessStartTime":"133000000000000101"}' | ConvertFrom-Json)
  throw 'PARENT_REPLACEMENT_DURING_CAPTURE_ACCEPTED'
} catch { if ($_.Exception.Message -notmatch 'STALE_FRAME:') { throw } }
Write-Output 'WINDOWS_INPUT_PROBE_OK'
`;
    const dir = mkdtempSync(path.join(tmpdir(), 'cos-input-test-'));
    try {
      const file = path.join(dir, 'probe.ps1');
      writeFileSync(file, script + assertions, 'utf8');
      const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
        // Compiles C# in a cold PowerShell; under the full CI suite that has exceeded 25 s.
        encoding: 'utf8', timeout: 90_000, windowsHide: true
      });
      expect(result.error, `${result.error?.message ?? ''} ${result.signal ?? ''} ${result.stderr}`).toBeUndefined();
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(result.stdout).toContain('WINDOWS_INPUT_PROBE_OK');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 100_000);
});
