#requires -Version 5.1
# Local owner UI; the helper authenticates the loopback management request.
function Show-GMSSHControllers {
    $helper = Get-GMSSHConnectHelper $root
    $manifest = Get-Content (Join-Path $root 'connect-payload.json') -Raw | ConvertFrom-Json
    if ($manifest.controllerProtocol -ne 2) {
        [void][Windows.Forms.MessageBox]::Show('请先升级 / 修复服务端组件，再使用独立授权和会话管理。','GMSSH Windows')
        return
    }
    $form = New-Object Windows.Forms.Form
    $form.Text = 'GMSSH Windows · 会话与授权'; $form.ClientSize = New-Object Drawing.Size(900,690)
    $form.StartPosition = 'CenterParent'; $form.BackColor = $background; $form.ForeColor = [Drawing.Color]::WhiteSmoke
    $form.Font = New-Object Drawing.Font('Segoe UI',10); $form.MinimumSize = New-Object Drawing.Size(916,729)
    if ($brandIcon) { $form.Icon = $brandIcon }; Set-GMSSHDarkTitleBar $form
    [void](New-AgentLabel $form '独立授权会话' 20 16 500 30)
    $scope = New-AgentLabel $form '这里只列出通过独立授权通道建立的连接；原共享密码和外部 RustDesk 连接继续由各自通道管理。' 20 49 860 40
    $scope.ForeColor = $muted
    $sessions = New-Object Windows.Forms.ListView
    $sessions.SetBounds(20,92,860,172); $sessions.View = 'Details'; $sessions.FullRowSelect = $true; $sessions.MultiSelect = $false
    $sessions.BackColor = $surface; $sessions.ForeColor = [Drawing.Color]::WhiteSmoke
    foreach ($column in @(@('管理端',175),@('通道',90),@('状态',120),@('来源',175),@('开始时间',240))) { [void]$sessions.Columns.Add($column[0],$column[1]) }
    $form.Controls.Add($sessions)
    $refresh = New-AgentButton $form '刷新' 20 274 140 34
    $disconnect = New-AgentButton $form '断开选中会话' 172 274 180 34
    [void](New-AgentLabel $form '管理端授权' 20 326 150 28)
    $selector = New-Object Windows.Forms.ComboBox
    $selector.SetBounds(20,362,350,30); $selector.DropDownStyle = 'DropDownList'; $selector.DisplayMember = 'name'; $form.Controls.Add($selector)
    $name = New-Object Windows.Forms.TextBox
    $name.SetBounds(386,362,494,30); $name.MaxLength = 80; $form.Controls.Add($name)
    [void](New-AgentLabel $form '新授权名称（例如：值班电脑）' 386 330 494 28)
    $checks = @{}; $labels = [ordered]@{view='查看桌面';input='键盘与鼠标';clipboard='文本剪贴板';files='文件读写';terminal='命令执行';power='电源操作'}
    $index = 0
    foreach ($key in $labels.Keys) {
        $check = New-Object Windows.Forms.CheckBox
        $check.Text = $labels[$key]; $check.SetBounds((20 + ($index % 3)*286),(410 + [Math]::Floor($index/3)*36),260,30)
        $check.BackColor = $background; $check.ForeColor = [Drawing.Color]::WhiteSmoke; $check.Checked = ($key -eq 'view')
        $checks[$key] = $check; $form.Controls.Add($check); $index++
    }
    $warningText = '所有授权均可读取设备监控和只读工具。这些开关约束 GMSSH 的对应通道，并非 Windows 系统沙箱。键鼠、文件写入或命令执行可通过 Windows 本身完成其他操作。只看连接请仅勾选“查看桌面”。'
    $warningLabel = New-AgentLabel $form $warningText 20 492 860 48; $warningLabel.ForeColor = $warning
    $create = New-AgentButton $form '创建并复制长期授权码' 20 554 270 38 $true
    $update = New-AgentButton $form '更新所选授权权限' 304 554 230 38
    $revoke = New-AgentButton $form '撤销所选管理端' 548 554 220 38
    $qr = New-AgentButton $form '二维码' 780 554 100 38
    $qr.Enabled = $false; $shareState = [pscustomobject]@{code=$null}
    $message = New-AgentLabel $form '' 20 608 860 60; $message.ForeColor = $muted
    $loading = $false
    function Invoke-ControllerRequest($Value) {
        $raw = Invoke-GMSSHConnectHelper -ProgramRoot $root -DataRoot $dataRoot -Operation manage -InputJson ($Value | ConvertTo-Json -Depth 6 -Compress)
        $reply = $raw | ConvertFrom-Json
        if (-not $reply.ok) { throw '会话服务拒绝操作。' }
        $reply.result
    }
    function Refresh-Controllers {
        try {
            $value = Invoke-ControllerRequest @{action='list'}
            $selectedId = if ($selector.SelectedItem) { $selector.SelectedItem.id } else { '' }
            $loading = $true; $sessions.Items.Clear(); $selector.Items.Clear()
            [void]$selector.Items.Add([pscustomobject]@{id='';name='创建新授权';permissions=@{view=$true}})
            foreach ($item in @($value.controllers)) { [void]$selector.Items.Add($item) }
            $selector.SelectedIndex = 0
            for ($i=1;$i -lt $selector.Items.Count;$i++) { if ($selector.Items[$i].id -ceq $selectedId) { $selector.SelectedIndex=$i;break } }
            $channels = @{desktop='桌面';files='文件';terminal='终端';power='电源'}
            $states = @{handshaking='握手中';authenticating='认证中';connected='已连接';auth_failed='认证失败';ready='通道就绪';disconnected='已断开'}
            foreach ($session in @($value.sessions)) {
                $row = New-Object Windows.Forms.ListViewItem([string]$session.name)
                [void]$row.SubItems.Add([string]$channels[$session.kind]); [void]$row.SubItems.Add([string]$states[$session.state]); [void]$row.SubItems.Add([string]$session.address)
                [void]$row.SubItems.Add(([DateTime]::Parse($session.started).ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss')))
                $row.Tag = $session.id; [void]$sessions.Items.Add($row)
            }
            $loading = $false; $message.Text = '会话：'+$sessions.Items.Count+' · 独立授权：'+@($value.controllers).Count+'。关闭本窗口不影响连接。'
        } catch { $loading=$false; $message.Text='读取未完成，请确认连接码服务已启用，并尝试刷新。' }
    }
    $selector.Add_SelectedIndexChanged({
        if ($loading -or -not $selector.SelectedItem) { return }
        $item=$selector.SelectedItem;foreach ($key in $labels.Keys) { $checks[$key].Checked=[bool]$item.permissions.$key }
        $update.Enabled=$revoke.Enabled=([bool]$item.id)
    })
    $refresh.Add_Click({ Refresh-Controllers })
    $disconnect.Add_Click({
        if ($sessions.SelectedItems.Count -ne 1) { $message.Text='请先选中一个具体会话。';return }
        try { [void](Invoke-ControllerRequest @{action='disconnect';id=$sessions.SelectedItems[0].Tag});Refresh-Controllers } catch { $message.Text='会话可能已结束，请刷新列表后核对。' }
    })
    $create.Add_Click({
        if (-not $name.Text.Trim()) { $message.Text='请先输入新授权的名称。';return }
        if ((-not $checks.view.Checked) -and ($checks.input.Checked -or $checks.clipboard.Checked)) { $message.Text='键鼠和剪贴板需要同时允许查看桌面。';return }
        $policy=@{};foreach ($key in $labels.Keys) { $policy[$key]=$checks[$key].Checked }
        if ([Windows.Forms.MessageBox]::Show('此授权码长期有效，持有人可使用所选通道。你可以在本窗口单独撤销该管理端。是否创建并复制？','GMSSH Windows · 创建独立授权','OKCancel') -ne 'OK') { return }
        try {
            $value=Invoke-ControllerRequest @{action='grant';name=$name.Text.Trim();permissions=$policy}
            $shareState.code=[string]$value.code; $qr.Enabled=$true
            [Windows.Forms.Clipboard]::SetText($shareState.code); $value=$null;Refresh-Controllers
            $message.Text='长期授权码已复制。请仅交给对应管理端；撤销会关闭该授权的活动会话，不影响其他授权。'
        } catch { $message.Text='授权未能创建，请检查服务状态；请勿重复创建不必要的授权。' }
    })
    $qr.Add_Click({
        if (-not $shareState.code) { return }
        $qrForm=$null; $image=$null; $stream=$null
        try {
            $encoded=Invoke-GMSSHConnectHelper -ProgramRoot $root -DataRoot $dataRoot -Operation qr -InputJson (@{text=$shareState.code} | ConvertTo-Json -Compress)
            $stream=[IO.MemoryStream]::new([Convert]::FromBase64String($encoded));$image=[Drawing.Image]::FromStream($stream)
            $qrForm=New-Object Windows.Forms.Form;$qrForm.Text='GMSSH · 独立授权二维码';$qrForm.ClientSize=New-Object Drawing.Size(540,610);$qrForm.StartPosition='CenterParent';$qrForm.BackColor=$background;$qrForm.ForeColor=[Drawing.Color]::WhiteSmoke
            $picture=New-Object Windows.Forms.PictureBox;$picture.SetBounds(20,20,500,500);$picture.SizeMode='Zoom';$picture.BackColor=[Drawing.Color]::White;$picture.Image=$image;$qrForm.Controls.Add($picture)
            [void](New-AgentLabel $qrForm '此二维码包含刚创建的长期授权，仅分享给对应管理端。撤销该授权后，旧二维码不能再连接。' 20 538 500 56)
            [void]$qrForm.ShowDialog($form)
        } catch { $message.Text='二维码生成未完成，可继续使用已经复制的授权码。' }
        finally { if($qrForm){$qrForm.Dispose()};if($image){$image.Dispose()};if($stream){$stream.Dispose()} }
    })
    $update.Add_Click({
        $item=$selector.SelectedItem;if (-not $item.id) { return };$policy=@{};foreach ($key in $labels.Keys) { $policy[$key]=$checks[$key].Checked }
        try { [void](Invoke-ControllerRequest @{action='permissions';id=$item.id;permissions=$policy});Refresh-Controllers;$message.Text='权限已更新，该授权的现有会话已断开，重连后生效。' } catch { $message.Text='权限未更新，请核对选择和权限组合。' }
    })
    $revoke.Add_Click({
        $item=$selector.SelectedItem;if (-not $item.id) { return }
        if ([Windows.Forms.MessageBox]::Show(('撤销“'+$item.name+'”？这会立即断开它的独立授权会话。原共享密码接入不受此操作影响。'),'GMSSH Windows','OKCancel') -ne 'OK') { return }
        try { [void](Invoke-ControllerRequest @{action='revoke';id=$item.id});Refresh-Controllers;$message.Text='该管理端的独立授权已撤销，旧授权码不能再连接。' } catch { $message.Text='撤销未完成，请刷新并核对该授权是否仍存在。' }
    })
    try { Refresh-Controllers; [void]$form.ShowDialog($panel) } finally { $shareState.code=$null; $form.Dispose() }
}
