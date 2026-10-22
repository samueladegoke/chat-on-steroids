import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HELPER_SCRIPT } from '../src/main/computer/helper.js';

const uiMutation = HELPER_SCRIPT.match(/function Invoke-UiMutation\([\s\S]*?(?=function Invoke-UiAction\()/)?.[0] ?? '';
const uiAction = 'function Invoke-UiAction(' + HELPER_SCRIPT.split('function Invoke-UiAction(')[1]?.split('function Get-RequestedClickCount(')[0];
const actUiElement = 'function Act-UiElement($request) {' + HELPER_SCRIPT.split('function Act-UiElement($request) {')[1]?.split('function Find-UiElements($request) {')[0];

function runReceiptScript(script: string, marker: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cos-uia-receipt-'));
  try {
    const file = path.join(dir, 'receipt.ps1');
    writeFileSync(file, script, 'utf8');
    const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    expect(res.status, `${res.stderr} ${res.stdout}`).toBe(0);
    expect(res.stdout).toContain(marker);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

it('wraps every UIA mutator, and only the mutation, in an ambiguous-completion boundary', () => {
  const calls = (uiAction + actUiElement).split('\n').filter(line => /\.(?:SetFocus|Invoke|Toggle|Select|Expand|Collapse|ScrollIntoView|Scroll|SetValue)\(/.test(line));
  expect(calls.map(line => line.trim())).toEqual([
    "Invoke-UiMutation 'focus' { $element.SetFocus() }",
    "'invoke' { Invoke-UiMutation $action { ([System.Windows.Automation.InvokePattern]$pattern).Invoke() } }",
    "'toggle' { Invoke-UiMutation $action { ([System.Windows.Automation.TogglePattern]$pattern).Toggle() } }",
    "'select' { Invoke-UiMutation $action { ([System.Windows.Automation.SelectionItemPattern]$pattern).Select() } }",
    "'expand' { Invoke-UiMutation $action { ([System.Windows.Automation.ExpandCollapsePattern]$pattern).Expand() } }",
    "'collapse' { Invoke-UiMutation $action { ([System.Windows.Automation.ExpandCollapsePattern]$pattern).Collapse() } }",
    "'scroll_into_view' { Invoke-UiMutation $action { ([System.Windows.Automation.ScrollItemPattern]$pattern).ScrollIntoView() } }",
    'Invoke-UiMutation $action { $scroll.Scroll($horizontal, $vertical) }',
    "Invoke-UiMutation 'set_value' { $value.SetValue([string]$request.value) }",
    "Invoke-UiMutation 'invoke' { ([System.Windows.Automation.InvokePattern]$pattern).Invoke() }",
    "Invoke-UiMutation 'toggle' { ([System.Windows.Automation.TogglePattern]$pattern).Toggle() }",
    "Invoke-UiMutation 'select' { ([System.Windows.Automation.SelectionItemPattern]$pattern).Select() }",
  ]);
});

describe.runIf(process.platform === 'win32')('UIA mutations with lost provider acknowledgements', () => {
  // Real UIA patterns cannot be replaced by PSCustomObjects through the helper's casts.
  // Exercise the boundary with throwing .NET methods; the source assertion ties it to every call site.
  it.each([
    ['semantic click Invoke', 'invoke', '$provider.Invoke()'],
    ['ui_action Toggle', 'toggle', '$provider.Toggle()'],
    ['set_value SetValue', 'set_value', "$provider.SetValue('new value')"],
  ])('reports %s as INPUT_EFFECT_UNCONFIRMED after a provider effect', (_label, action, mutation) => {
    const script = String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
public class ReceiptProvider {
  public bool Applied;
  private void ApplyThenThrow() { Applied = true; throw new System.Runtime.InteropServices.COMException("PROVIDER_COM_ERROR"); }
  public void Invoke() { ApplyThenThrow(); }
  public void Toggle() { ApplyThenThrow(); }
  public void SetValue(string value) { ApplyThenThrow(); }
}
'@
${uiMutation}
$provider=New-Object ReceiptProvider
$message=''
try { Invoke-UiMutation '${action}' { ${mutation} } } catch { $message=$_.Exception.GetBaseException().Message }
if (!$provider.Applied) { throw 'MISSING_PROVIDER_EFFECT' }
if (!$message.StartsWith('INPUT_EFFECT_UNCONFIRMED:') -or !$message.Contains('PROVIDER_COM_ERROR')) { throw "WRONG_COMPLETION: $message" }
$code='HELPER_ERROR'
if ($message -match '^([A-Z0-9_]+):\s*(.+)') { $code=$Matches[1] }
if ($code -cne 'INPUT_EFFECT_UNCONFIRMED') { throw 'TRANSPORT_LOST_AMBIGUITY_CODE' }
$message=''
try { Invoke-UiMutation 'nested' { throw 'INPUT_EFFECT_UNCONFIRMED: original' } } catch { $message=$_.Exception.GetBaseException().Message }
if ($message -cne 'INPUT_EFFECT_UNCONFIRMED: original') { throw 'DOUBLE_WRAPPED_AMBIGUITY' }
Write-Output 'PROVIDER_EFFECT_IS_UNCONFIRMED'
`;
    runReceiptScript(script, 'PROVIDER_EFFECT_IS_UNCONFIRMED');
  });

  it('keeps pre-mutation unsupported-pattern and disabled-element refusals exact', () => {
    const script = String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
$script:UiActionNames=@('toggle')
$script:element=[pscustomobject]@{ Current=[pscustomobject]@{ IsEnabled=$true; Name='Control' } }
$script:element | Add-Member -MemberType ScriptMethod -Name TryGetCurrentPattern -Value { param($patternId,$pattern) return $false }
function Resolve-UiElement($window,$snapshotId,$runtimeKey) { return $script:element }
function Assert-InputOwner($target,$owner,$targetApp,$ownerApp) { }
function Write-UiaStage($marker) { }
${uiMutation}
${uiAction}
${actUiElement}
$message=''
try { Invoke-UiAction $script:element 'toggle' 77 $null $null $null } catch { $message=$_.Exception.GetBaseException().Message }
if (!$message.StartsWith('UI_ACTION_UNSUPPORTED:')) { throw "WRONG_REFUSAL: $message" }
$script:element.Current.IsEnabled=$false
$message=''
try { Act-UiElement @{ id=77; snapshotId=1; runtimeKey='control'; action='toggle' } } catch { $message=$_.Exception.GetBaseException().Message }
if (!$message.StartsWith('UI_ELEMENT_DISABLED:')) { throw "WRONG_REFUSAL: $message" }
Write-Output 'PRE_MUTATION_REFUSALS_STAY_EXACT'
`;
    runReceiptScript(script, 'PRE_MUTATION_REFUSALS_STAY_EXACT');
  });
});

describe.runIf(process.platform === 'win32')('semantic UI completion after a self-removing control', () => {
  it('does not downgrade completed Invoke to failure when metadata vanishes afterward', () => {
    const action = 'function Act-UiElement($request) {' + HELPER_SCRIPT.split('function Act-UiElement($request) {')[1]?.split('function Find-UiElements($request) {')[0];
    expect(action).toContain('Act-UiElement');
    const harness = String.raw`
$ErrorActionPreference='Stop'
$script:UiActionNames=@('invoke')
$script:mutated=$false
$current=[pscustomobject]@{ IsEnabled=$true }
$current | Add-Member -MemberType ScriptProperty -Name Name -Value { if ($script:mutated) { throw 'ELEMENT_VANISHED_AFTER_INVOKE' }; return 'Close dialog' }
$script:element=[pscustomobject]@{ Current=$current }
function Resolve-UiElement($window,$snapshotId,$runtimeKey) { return $script:element }
function Assert-InputOwner($target,$owner,$targetApp,$ownerApp) { }
function Write-UiaStage($marker) { }
function Ui-RuntimeKey($element) { return 'native-before-1' }
function Invoke-UiAction($element,[string]$action) { $script:mutated=$true }
`;
    const script = harness + action + String.raw`
$result=Act-UiElement @{ id=77; snapshotId=1; runtimeKey='native-before-1'; action='invoke' }
if (!$script:mutated -or $result.route -cne 'uia' -or $result.name -cne 'Close dialog') { throw 'MISSING_COMPLETED_ACTION_RECEIPT' }
Write-Output 'POST_MUTATION_PROVIDER_REMOVAL_PRESERVES_COMPLETION'
`;
    const dir = mkdtempSync(path.join(tmpdir(), 'cos-uia-receipt-'));
    try {
      const file = path.join(dir, 'receipt.ps1');
      writeFileSync(file, script, 'utf8');
      const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', timeout: 20000, windowsHide: true });
      expect(res.status, `${res.stderr} ${res.stdout}`).toBe(0);
      expect(res.stdout).toContain('POST_MUTATION_PROVIDER_REMOVAL_PRESERVES_COMPLETION');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
