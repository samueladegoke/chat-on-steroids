import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HELPER_SCRIPT } from '../src/main/computer/helper.js';

describe.runIf(process.platform === 'win32')('native physical hit receiver validation', () => {
  it('accepts an owned context-menu popup but rejects an unrelated no-activate overlay', () => {
    // Compile the production HitTargetsWindow against deterministic ownership
    // fixtures; no windows, focus or OS input are modified.
    const method = '  public static bool HitTargetsWindow(long handle, int x, int y) {' +
      HELPER_SCRIPT.split('  public static bool HitTargetsWindow(long handle, int x, int y) {')[1]?.split('  public static bool InputIsFocused(')[0];
    expect(method).toContain('GetAncestor');
    const fixture = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
public static class Clf {
  public struct POINT { public int X, Y; }
  static IntPtr WindowFromPoint(POINT p) { return new IntPtr(p.X); }
  static IntPtr GetAncestor(IntPtr hwnd, uint kind) {
    if (kind == 2) return hwnd; // GA_ROOT leaves the owned popup separate
    if (kind == 3 && hwnd.ToInt64() == 201) return new IntPtr(100); // GA_ROOTOWNER
    return hwnd; // foreign no-activate overlay 301 is independent
  }
` + method + String.raw`
}
"@
if (-not [Clf]::HitTargetsWindow(100, 100, 0)) { throw 'TARGET_WINDOW_REJECTED' }
if (-not [Clf]::HitTargetsWindow(100, 201, 0)) { throw 'OWNED_MENU_REJECTED' }
if ([Clf]::HitTargetsWindow(100, 301, 0)) { throw 'FOREIGN_OVERLAY_ACCEPTED' }
if ([Clf]::HitTargetsWindow(100, 0, 0)) { throw 'NULL_HIT_ACCEPTED' }
Write-Output 'OWNED_POPUP_ALLOWED_FOREIGN_OVERLAY_DENIED'
`;
    const dir = mkdtempSync(path.join(tmpdir(), 'cos-owner-hit-'));
    try {
      const script = path.join(dir, 'owner-hit.ps1');
      writeFileSync(script, fixture, 'utf8');
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
        encoding: 'utf8', windowsHide: true, timeout: 25_000
      });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(result.stdout).toContain('OWNED_POPUP_ALLOWED_FOREIGN_OVERLAY_DENIED');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects an overlay before physical indexed-click sends any OS input', () => {
    const hit = 'function Assert-PhysicalHit([int64]$id, [int]$x, [int]$y) {' +
      HELPER_SCRIPT.split('function Assert-PhysicalHit([int64]$id, [int]$x, [int]$y) {')[1]?.split('function Assert-CoordinateFrame(')[0];
    const action = 'function Act-UiElement($request) {' + HELPER_SCRIPT.split('function Act-UiElement($request) {')[1]?.split('function Find-UiElements($request) {')[0];
    expect(hit).toContain('HitTargetsWindow');
    const source = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
public static class Clf {
  public static int Clicks=0;
  public static bool InputIsFocused(long id) { return true; }
  public static bool HitTargetsWindow(long id, int x, int y) { return false; }
  public static void Click(int x, int y, string button, int times) { Clicks++; }
}
"@
$script:UiActionNames=@('invoke')
$current=[pscustomobject]@{ IsEnabled=$true; Name='Blocked'; BoundingRectangle=[pscustomobject]@{ X=10; Y=10; Width=10; Height=10 } }
$script:element=[pscustomobject]@{ Current=$current }
function Resolve-UiElement($window,$snapshotId,$runtimeKey) { return $script:element }
function Assert-InputOwner($target,$owner,$targetApp,$ownerApp) { }
function Assert-Focused($id) { }
function Write-UiaStage($marker) { }
function Get-RequestedClickCount($request) { return 1 }
` + hit + action + String.raw`
try { $null=Act-UiElement @{ id=77; snapshotId=1; runtimeKey='occluded'; action='click'; button='right'; count=1 }; throw 'UNEXPECTED_CLICK' } catch {
  if ($_.Exception.Message -notmatch '^OCCLUDED_TARGET:') { throw }
}
if ([Clf]::Clicks -ne 0) { throw 'OCCLUDED_PIXEL_RECEIVED_SENDINPUT' }
Write-Output 'OCCLUSION_FAILS_CLOSED_BEFORE_POINTER_DOWN'
`;
    const dir = mkdtempSync(path.join(tmpdir(), 'cos-hit-guard-'));
    try {
      const script = path.join(dir, 'occlusion.ps1');
      writeFileSync(script, source, 'utf8');
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(result.stdout).toContain('OCCLUSION_FAILS_CLOSED_BEFORE_POINTER_DOWN');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
