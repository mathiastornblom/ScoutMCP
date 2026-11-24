# eLux terminal.ini — Reference Transcription

Primary source: `UC-eLux terminal.ini-250526-120701.pdf` (Unicon documentation, dated 2025-05-26,
50 pages, read in full via the `pages` parameter in chunks of ≤20). This is the newest/most
authoritative terminal.ini reference and wins on conflict with the older doc.

Cross-check source: `eLux terminal.ini.pdf` (older reference, 33 pages) — used only to fill gaps
or resolve ambiguity. Not separately transcribed in full here; specific cross-checks are noted
inline where they affected a value.

This is a plain-markdown transcription of the parameter tables in the source PDF, used as the
input for `scripts/generate-elux-schema.ts`. Source table columns, in order: Parameter | Default
Value | Value Range | Description | Publish? | Datamodel Object | ...since version?

Notation used below:
- `(unset)` = no default value rendered in the source table (blank cell).
- `?` in the Publish column = the source literally renders a `?` character (seen in `[Hotkeys]`).
- Section banner notes (e.g. "Values are updated when booting") are preserved as blockquotes.
- `!` rows in the source PDF are continuation/enum-explanation rows for the parameter directly
  above them (the source repeats `!` as the Parameter cell to mean "see above"); these are folded
  into the Value Range / Description of the parent row in this transcription, with a note.

Sections in document order (table of contents from PDF page 1):

[Global] [Network] [Desktop] [Layout] [Screen] [UpdateInfo] [Security] [LicenseInfo] [Multimedia]
[NetDriveList] [!NETDRIVE!#] [Printd] [PrinterList] [!PRINTER!#] [Hardware] [HwInfo] [Com#Settings] [Environment]
[Keyboard] [ethernet] [wavelan] [tokenring] [HW-monitor] [USB] [dconfm] [gconfm] [xscreensaver]
[xscreensaver_html5] [xscreensaver_dialog] [PPTP] [ScoutHandshake] [nfs_options] [pkcs11]
[pkcs11 <string>] [SmartCard] [Statistics] [ICALayout] [PNLLayout] [DynamicProxy] [UpdateWatcher]
[ctxh264] [FileFetch] [PowerManagement] [PowerManagementEco] [PowerManagementEcoNonWorking]
[PowerManagementPerformance] [PowerManagementPerformanceNonWorking] [Bluetooth] [Hotkeys] [Xorg]
[Evidian] [OpenId] [Imprivata] [SAML] [VirtualKeyboard] [Swap] [MemoryOptimisation]

---

## [Global]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| LogLevel | 0 | 0-6 | Log level | no | | |
| SysLogLevel | 0 | 0-1 | Activates log files for eluxd only (6.11.1). **Removed in eLux 7** | | | removed in elux7.0.0 |
| LogCycles | 5 | >=2 | Save cycle versions of the logfiles last_boot.zip | no | | |
| LogPath | /setup/logs | | File path where the logfiles last_boot.zip are stored | yes | | |
| DiagURL | empty | ftp://ftpserver.de (example) | The URL where the diagnostic data should be sent to | no | | |
| verbose | false | | high level Xserver trace to /tmp/X.log | no | | |
| USB | true | true,false | Specifies whether USB mass storage devices are to be allowed for use. | no | | |
| USBCD,USBFD,MemoryBird | | obsolete | | no | | |
| USBUserInfo | true | true,false | Specifies whether the user should be informed when an USB mass storage device is connected | no | | |
| UseRamDisk | depends on main memory | #kB | | no | | |
| MaxRamDisk | (unset) | | | no | | |
| MinRamDisk | (unset) | | | no | | |
| Autostart | true | true,false | Enable or disable start of sessions marked as autostart | no | | |
| FactorySettings | true | true,false | Indicates whether the first contact wizard should be displayed | no | | |
| LastShutdownAction | (unset) | 0,5 | Determines which action should be executed when the last active application is closed | no | | |
| Zone | Europe/Berlin | | Specifies the time zone | no | | |
| Timeout | 5 | #sec | Timeout in seconds, after which the attempt to connect to the manager is cancelled. | no | | |
| LprTimeoutSave | 10 | #sec | Timeout, after which a LPR-print is to be cancelled. | no | | |
| LprTimeout | (unset) | #sec | Timeout, after which a LPR-print is to be cancelled, if 0 no timeout is set | no | | |
| LpdService | true | true,false | Specifies whether the LPD Service is to be initiated at the client. | no | | |
| ComSettings | true | true,false | denies com port initialization | no | | |
| RestartXOnLogoff | (unset) | | (no description given in source) | no | | |
| WaitAppClose | 1 | #sec | Seconds to wait until application closes before killing it | no | | |
| ClientIdLegacy | false | true,false | since 4.9.0: enforces the same mac address behaviour as it was in 4.1.0 | no | | |
| EnableVirtualKeyboard | false | true,false | If true and a virtual keyboard package (maliit) is installed the virtual keyboard is activated | yes | | |
| DisableUsbStorageAutomount | false | true,false | Disables automount of USB storage devices. Is evaluated by "/etc/init.d/usbStorageAutomount". | no | | |
| WinConfigurationTimeOut | 900 | int (seconds) | How long WinScoutAgent waits before rebooting on configuration change | no | | |
| ActionAfterLastWfica | 0 | 0=nothing,1=reboot,2=shutdown,4=logoff,8=lock,16=VPN disconnect | Specifies action to take place if the last Citrix Receiver instance (app/desktop) was closed, when using Firefox web browser in kiosk mode. | yes | | |
| SearchWficaPidCount | (unset) | | (no setting needed, leave in code with default ≈100) | | | |
| ActionIfNoAppRunning | 0 | 0=nothing,1=reboot,2=shutdown,4=logoff,8=lock,16=VPN disconnect | Specifies action to take place if the last application/session was closed | no | | |
| ActionIfNoAppRunningDelay | 0 | int (seconds) | Specifies how long specified action is delayed | no | | |
| IdleTimeout | 10 | int (seconds) | Timeout of Scout Agent if waiting for response from Scout | no | | |
| USBRedirectOnly | false | true,false | USB devices can be used redirected only | no | | |
| USBUseRules | false | true,false | USB rules are active and will be obeyed | no | | |
| DoFactoryReset | false | true,false | Executes factory reset on boot/shutdown if true | no | | |
| FactoryResetOption | (unset) | 0=none,1=keep Scout,2=halt,4=reboot,8=remove licences,16=preserve unlocked fields | Options for factory reset | no | | |
| UpdateLastContactInterval | 1440 | unsigned int | Interval in minutes for sending tstatus up if jpmc_updating_last_contact is installed (publish to JPMC only) | | | |
| OSName | (unset) | | Name of operating system (f.e. eLux RP) | no | | |
| OSVersion | (unset) | | Full qualifying version of operating system | no | | |
| ServerFeatures | (unset) | | Decimal representation of Scout supported features, depending on currently used Scout. Bit flags: FEATURE_HELPDESK 0x0001, FEATURE_CFGIO 0x0002, FEATURE_LICENCEIO 0x0004, FEATURE_DETAILEDSECURITY 0x0008, FEATURE_HIERARCHIES 0x0010, FEATURE_ELUXRL 0x0020, FEATURE_NETWORKPROFILES 0x0040, FEATURE_ELUXRT 0x0080, FEATURE_WES7 0x0100, FEATURE_ELUXRP 0x0200, FEATURE_RELOCATION 0x0400, FEATURE_CONFIGSNAPSHOT 0x0800, FEATURE_ANDROID 0x1000, FEATURE_RP6 0x2000. (Source note: as of 2024-04-18 this hasn't been updated for at least 6 years.) | no | | |
| ThinPrintChannel | 0 | 0=TCP/IP,1=RDP/ICA | ThinPrint transfer protocol to be used by thinprint client | no | | |
| ConfigurationId | (unset) | | Identifies currently used Scout configuration | no | | |
| InstallLogLevel | 0 | integer | Log stdout and stderr of package scripts during update to eluxman.log, even if the return code is 0 | no | | |
| AutoRequestLicenses | 0 | 0=Off,1=by package,2=by software | How licenses are requested by the client (eLux RP 6.4 required) | no | | |
| GroupID | 0 | | OU-ID, to resolve ID to name you have to query Scout | no | | |
| GroupName | (unset) | | (marked for removal from code per source annotation) | | | |
| FollowMeDesktop | false | true,false | Activate FollowMeDesktop feature | | | |
| PcscLogging | false | true,false | Activate advanced logging in pcsc lite package | | | |
| Development | false | true,false | **Since RP 6.10:** If set to true development logging is activated. At the moment this impacts the coreinstaller and the boot ramdisk. If set to true coreinstaller will open a shell in case of error instead of doing a reboot. Scripts run in the initramdisk will be executed with debug output "set -x". The logs can be found in /setup/logs/{init,update}.log | | | |
| ClientIdentifier | "" | Example: {50095A7A-39EA-4B1C-9C08-4E7F7CF5E44C} | Unique id created and sent to client by Scout. | | | |
| MemoryTrapValue | 80 | 30-100 | If memory usage exceeds this threshold (in percent), user gets a warning | | | |
| MinSpace | 5 | 0-100 | If available disk space (/setup, /tmp) falls below this threshold (in percent), user gets a warning | | | |
| TimeFormat | 0 | 0=Auto (12h for en_US desktop, 24h for others), 1=12h (AM/PM), 2=24h | Shows current time in the given format | | | |
| DefaultSystemBrowsers | google-chrome,chromium,firefox,ucbrowser | one or more of chromium, google-chrome, firefox, edge | Set the first browser of the list, if installed, as the system default browser (used by xdg-open <url>) | | Desktop.DefaultSystemBrowsers | 7.2505 |
| PersistentHomeApplications | (unset) | ALL or comma-separated list with one or more of ica, google-chrome, firefox, edge, gnome-keyring | The list specifies applications for which persistent home is enabled. Setting this to ALL applies the policy to all supported applications where EPM is configured in the IDF. Example to set some applications instead of ALL: ica,google-chrome,edge. The list is comma-separated and no whitespace. When firefox is in PersistentHomeApplications, firefox related configs (like `HomeDirectory`) MUST NOT be set. | yes | | 7.2511 |

> Honesty flag: five rows in `[Global]` (IdleTimeout, USBRedirectOnly, USBUseRules,
> ThinPrintChannel, ConfigurationId, DefaultSystemBrowsers) had their Parameter-name cell rendered
> blank or cut off in the primary (2025-05-26) source PDF's table screenshot. They were
> cross-checked and resolved against the older `eLux terminal.ini.pdf` reference, which renders
> the same rows (same defaults, ranges, descriptions) with the parameter names intact. Per this
> workstream's source-priority rule the newer doc wins on conflicting *values*, but here there was
> no conflict — only a missing name — so the older doc's name was adopted directly rather than
> guessed. These rows are treated as confident reads, not `inferred: true`.

## [Network]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| Timeout | (unset) | #sec | obsolete, DHCP Timeout is defined in profiles.ini→[<Network-Profile>]→DhcpTimeout | no | | |
| BootMode | (unset) | dhcp, bootp, off | Specifies whether the client gets its network data via DHCP, BOOTP or enters the data individually. | no | | |
| DisableIPv6 | false | true,false | Disables IPv6 networking support | yes | | |
| IPAddr | 192.168.10.21 | | IP address of the client | no | | |
| Netmask | 255.255.255.0 | | Network mask of the client | no | | |
| Hostname | myclient | | Host name of the client | no | | |
| HostNameTemplate | (unset) | valid hostname | Auto-create hostname from template which can contain the following patterns: %HOSTID% is replaced by the thin client's hostid; %MAC% is replaced by the thin client's mac address | no | | |
| IgnoreDHCPHostname | false | true,false | Ignores the hostname sent by the DHCP server | | | |
| IgnoreScoutServerDHCPOptionsGlobal | undefined | undefined,true,false | Ignore the Scout server DHCP options. If defined, it overloads the IgnoreScoutServerDHCPOptions setting from network profiles. | | | 6.2302.3 |
| Domain | (unset) | mycompany.com | domain name of the client | no | | |
| MTUMax | <leer> | 512..1500 | | no | | |
| MTU | <leer> | 512..MTUMax | | no | | |
| Broadcast | (unset) | | Broadcast address of the client | no | | |
| NBDomain | (unset) | DOM01 | Netbios domain name of the client | no | | |
| Dot1x | (unset) | obsolete | | no | | 6.2212 |
| Dot1xTimeout | 25 | obsolete | | no | | 6.2212 |
| Dot1xConf | (unset) | URL | URL of 802.1x config file. DHCP Tag 227 | no | | |
| Dot1xCert | (unset) | URL | Certificate URL. DHCP Tag 226 | no | | |
| Dot1xCA | (unset) | URL | URL of ROOT CA. DHCP Tag 230 | no | | |
| Dot1xCertPhrase | (unset) | <password> | Certificate password, DHCP Tag 228 | no | | |
| Dot1xCertPhraseCrypt | (unset) | <crypt password> | Crypted certificate password, from dhclient-script | no | | |
| Dot1xIdentity | (unset) | | Certificate Identity, account name on IAS, CN for Linux radius, DHCP Tag 229 | no | | |
| Dot1xFirstLoad | (unset) | true,false | detect initial loading of 802.1x configuration | no | | |
| Dot1xChanged | (unset) | true,false | Update 802.1x configuration | no | | |
| Dot1xDays | (unset) | #days | Anzahl der Tage ab der ein Hinweis angezeigt wird bevor das Zertifikat abläuft. (Number of days before certificate expiry a warning is shown.) | no | | |
| Dot1xAuthenticationRetries | 4 | | | | | |
| Dot1xAutoconnectRetries | 3 | | | | | |
| Dot1xOptional | true (from 6.9.1000 and 6.11) | true,false | | | | |
| HostName1 | myclient22 | | | | | |
| DHCPServer | false | true,false | not longer used | no | | |
| HW | (unset) | 12-digit hex string | The MAC address of the first ethernet device | no | | |
| MediaMac | (unset) | 12-digit hex string | The MAC address of the connected network device | no | | |
| TimeServer1 | (unset) | | Name or IP address of the time server | no | | |
| TimeServerProtocol1 | RFC868 | RFC868, NTP | Specifies the time server protocol. RFC868 = Unix-time server; NTP = Windows time server | no | | |
| VPN | (unset) | PPTP/vpnclient vpnc | Type of the vpnclients | no | | |
| VpnLocationCheckUrl | (unset) | Url | Used to determine whether the client is connected to the company's internal network - directly or via VPN. If the webserver responds with a file containing the text "Beacon is visible" an internal connection is assumed. Every change of network connectivity triggers this check again. The check is only performed if sandboxing of the internal browser is activated. | no | | |
| VpnLocationCheckTimeout | 10 | int | not used | | | |
| ManagerId | (unset) | | Identifies Scout database installation (marked for removal from code per source annotation) | | | |
| ManagerName | (unset) | | IP or Full Qualified Domain Name of Scoutserver (deployed per Scout), treated same as entry of ManagerNameList, so isn't needed, if ManagerNameList is present | no | | |
| ManagerNameList | (unset) | | comma separated List of IPs or Full Qualified Domain Name of Scoutservers (deployed per Scout) | no | | |
| ManagerAddrList | (unset) | | List of IPs generated from ManagerNameList | no | | |
| ManagerLoadBalancer | (unset) | Fully Qualified Domain-Name | Full Qualified Domain Name of Loadbalancer, which will be resolved by DNS Server to one of valid Scoutserver working on same database | yes | | |
| RequestAvayaTag | false | true,false | Used to alter DHCP client configuration for usage with the Avaya Equinox client. Can be set by Scout administrators that somehow know about this. Probably still in use (see EL-2677, OTRS 11969 or trac 3340). Warning: This will only request the following DHCP Tags: subnet-mask, broadcast-address, time-offset, routers, domain-name, domain-name-servers, host-name, avaya_vdi_communicator_option_242 — all others include the Scout tags | no | | |
| MergeWLANProfile | false | true,false | Merge transmitted wpa.conf with local auto connected wlan profile | yes | | |
| ETHLinkTimeout | 5 | int | >=6.2.4-4: Timeout for ethlink detection. Network script will wait for the given time to detect ethlink. RP5 >= 5.7.2002, default 10 | yes | | |
| ScoutCloudGateway | (unset) | string | The name or ip of the scout cloud gateway. | no | | |
| DisableSCEP2TPM | false | true,false | Disable storing private key in TPM2 space. | yes | | |
| SCEP | false | true,false | Enable SCEP agent for client certificate transfer/enrollment. | yes | Scep→Enabled | |
| EST | false | true,false | Enable EST agent for client certificate transfer/enrollment. | yes | Est→Enabled | |
| DisableScoutContactOnNetChange | false | true,false | Disable scout contact on network change | | | |
| ScoutMappingPath | (unset) | string | Since RP 6.9.1000: Filename of the ini file containing rules for directing the client to a specific scout server | | | |
| DisableConnectivityCheck | false | true,false | Since RP 6.9.101: Disable ConnectivityCheck globally. Setting in network profiles are ignored. | | | |
| BiosFile | (unset) | string | Name of the UDF file for uefifwupdate (relative to the usual update file location) | | | |
| OverwriteIdenticalOrHigherVersion | false | true,false | Allow re-installing the same or older firmware for uefifwupdate | | | |
| FqdnOption | off | off, auto, or Fully Qualified Domain Name string | Fully Qualified Domain Name of the client. Works as follows: (none)/"off"/(empty string): Don't use option 81; "auto": The hostname is constructed from network.Hostname and network.Domain; (qualified string): A string that contains a dot is taken literally — mostly for testing; Any other value: Undefined behavior. | no | FqdnOptionData in 6.2110.2, part of Network data in master | Only present in 6.2110.2 |
| CurrentProfile | (unset) | uint | ID of the currently active network profile | no | CurrentProfileId | |
| CurrentProfileUserDefined | false | true,false | False if currently active profile is defined in scout, true if by the user | no | CurrentProfileUserDefined | |
| ShowNotificationOnWlanDot1xFail | true | true,false | If false, suppress UI notification about wireless 802.1X notification failure | no | ShowNotificationOnWlanDot1xFail | |
| ShowNotificationOnEthernetDot1xFail | true | true,false | If false, suppress UI notification about LAN 802.1X notification failure | no | ShowNotificationOnEthernetDot1xFail | |
| DisableAutonegForAutoSpeed | true (baseos >= 6.2302.1000-4), false (baseos < 6.2302.1000-4) | true,false | Normally when network speed is set to 'Auto' we want to enable auto-negotiate setting for the relevant network connection. However with new network manager (at least 1.36+) this leads to problems on some hardware when using some network splitters. Surprisingly, disabling auto-negotiate (without specifying speed) for the relevant connection makes the connection work and negotiate speed with the switch. This is also consistent with the way Ubuntu configures network connections. | no | DisableAutonegForAutoSpeed | 6.2302.3, removed in eLux7, works as if always true |
| GetSetup | false | true,false | Force eluxd to fetch configuration on next boot | no | UpdateGetSetup (yes, really) | |
| KeepWpa2EnterpriseCredentialsFromLastUser | true | true,false | Remember WPA2 Enterprise credentials. Credentials are associated with an eLux user. If another eLux user logs in, these remembered WPA2 Enterprise credentials are deleted. | no | Network.KeepWpa2EnterpriseCredentialsFromLastUser | 7.2603.0 Beta 3 |
| Wpa2EnterpriseCredentialsKeptForUser | (unset) | string | Should not be set via Scout. If WPA2 Enterprise credentials were stored (because KeepWpa2EnterpriseCredentialsFromLastUser is enabled) this setting stores which eLux user the credentials are associated with. | no | Network.Wpa2EnterpriseCredentialsKeptForUser | 7.2603.0 Beta 3 |

> Honesty flag: Domain, MTUMax, MTU, VPN, VpnLocationCheckUrl, BiosFile,
> OverwriteIdenticalOrHigherVersion, and GetSetup were all resolved against the older
> `eLux terminal.ini.pdf` cross-check (same pattern as the [Global] section above) — confident
> reads, not inferred. No remaining unresolved gaps in `[Network]`.

## [Desktop]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| useCustomGridLayout | false | true,false | Enable desktop application launcher grid layout. See ELUX-5518. Works in concert with (1) the terminal.ini entry `customGridLabels`, (2) application free parameter `GridPosition=i,j` (where i is row, j is column, optional). Each application displayed on the desktop is required to have the "GridPosition" free parameter configured in Scout. Note: Scout Application parameter `showOnDesktop` is ignored, and `hidden` property leads to "empty" grid tiles. | no | | 7.2603.0 beta3 |
| customGridLabels | "" | string | Comma separated list of labels eg. `first label, second label, third label, ..` | no | | 7.2603.0 beta3 |

## [Layout]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| ShowTaskbar | true | true,false | Specifies whether the taskbar is to be displayed. | no | | |
| TaskbarAlwaysOnTop | true | true,false | Specifies whether the taskbar is to be always on top. | no | | |
| TaskbarAutoHide | true | true,false | Specifies whether the taskbar is to be hidden automatically. | no | | |
| TaskbarShowClock | true | true,false | Specifies whether the clock is to be shown in the taskbar. | no | | |
| AutostartStarter | true | true,false | Defines whether the System control should be started automatically on device start | no | | |
| StarterDelay | (unset) | #sec | Specifies the delay in seconds after which the starter is to be opened. | no | | |
| Workspace | (unset) | # | Specifies the number of the workspaces to be shown. | no | | |
| NextFocusKey | Down,Tab | Down,Tab | Specifies the shortkey for switching between active applications. Down=Use Ctrl-Alt-Down to switch between the applications; Tab=Use Alt-Tab to switch between the applications. | no | | |
| DesktopBackColor | #FF00FF | #rrggbb | Specifies the background color of the client desktop. Format is RGB: #rrggbb whereby rr=red, gg=green, bb=blue. | no | | |
| CurrentTheme | (unset) | unicon_default | Specify the eLux7 theme; requires theme resources to be available in /setup/elux/themes/<CurrentTheme>/. Note: Scout Background images are prioritized over the theme image, whereas the background color has lower priority. To disable the default themed background set this parameter to an invalid value, eg "invalidThemeWorkaround" | no | | eLux7 |
| Theme | greenCrux | greenCrux,blueCrux,Keramik,SilverXP,TrueCurve,WinClassic,XP | Specifies the desktop theme to be used. | no | | |
| BackgroundImageOption | (unset) | 1,2,3,4 | 1=zentriert (centered) 2=gedehnt (stretched) 3=gekachelt (tiled) 4=skaliert (scaled) | no | | |
| BackgroundImage | (unset) | background.jpg | The file name of a background image | no | | |
| TaskbarOption | 0x07 | bitmask | Specifies whether the applets of Quick Setup are to be shown in the taskbar. No Applet=0x0, MouseKeyboard=0x1, Multimedia=0x2, USB=0x4. The values are allocated by 'or'. | no | | |
| DesktopOption | 3 | bitmask | Decimal representation of desktop options (RP5): DT_OPT_SHOW_NON 0x0, DT_OPT_SHOW_DESKTOP 0x1, DT_OPT_SHOW_VOLUMES 0x2, DT_OPT_SHOW_HOMEFOLDER 0x4, DT_OPT_SHOW_COMPUTER 0x8, DT_OPT_SHOW_TRASH 0x10, DT_OPT_SHOW_NETWORK 0x20, DT_OPT_USE_CLASSIC 0x40 | no | | |
| UseScreenSaver | false | true,false | Specifies whether the screensaver is to be used. | no | | |
| XAutoLockDelay | (unset) | #min | Specifies the period of time in minutes, after which the screensaver is to be activated. | no | | |
| XAutoLockPwd | empty or $ELUXPASSWORD | empty,$ELUXPASSWORD | Entering the password $ELUXPASSWORD automatically uses the password of the ADS authorisation. Otherwise the field must remain empty. | no | | |
| ClientInfoHotKey | <Super_L><Alt>i | key combination | Show Device Info | yes | | |
| UsbUnmountHotKey | <Alt><Mod4><Hyper>s | key combination | Unmount all USB volumes. (WinKey+Alt+s) By default there is no hotkey defined. | yes | | |
| RestoreDesktop | false | true,false | Modern UI V1: Save/Restore desktop icons before/after logoff/logon | no | | |
| DesktopHomeDir | /setup/elux | <Directory> | Modern UI V1: Desktop icons are saved within this directory to the subdirectory .eluxdesktop, ($ELUXUSER, $ELUXDOMAIN; ...) can be used as part of the directory name | no | | |
| UseBackgroundImageBeforeLogon | false | true,false | Logon dialog uses background pixmap | no | | |
| UseScreenSaverBeforeLogon | false | true,false | Screensaver activate in logon dialog, a xscreensaver config can be given in /setup/xscreensaver/xslogon.ini | no | | |
| DesktopLayout | medium | small,medium,large | Modern UI V1: Size of desktop icons | yes | | |
| DesktopLogo | (unset) | <absolute file name to pixmap>, none | Modern UI V1: Show this logo in the upper left corner instead of eLux logo. Modern UI V2: Show this logo in the lower right corner instead of eLux logo. Modern UI V2: DesktopLogo=none hides the logo | yes | | |
| DesktopBackColr | #0080FF | #<rgb> | Modern UI V2: Desktop background color | no | | |
| DesktopHighlightedTextColor | #209ac0 | #<rgb> | Modern UI V2: Desktop highlighted text color | yes | | |
| DesktopTextColor | #546e7a / #ffffff | #<rgb> | Modern UI V2: Text color under desktop icons. Modern UI V1: Text color under desktop icons | yes | | |
| DesktopTextColorMenu | #ffffff | #<rgb> | Modern UI V1: Text color in menus | yes | | |
| DesktopBackgroundColorMenu | #000000 | #<rgb> | Modern UI V1: Menu background color | yes | | |
| DesktopTitleTextColor | #209ac0 | #<rgb> | Modern UI V2: text color of desktop title. Works with >=rp.6.5.2000 and >=rp.6.7.0; for < rp.6.5.2000 and rp6.6.0 use DesktopHighlightedTextColor instead | no | | |
| DesktopSearchTextColor | #616161 | #<rgb> | Modern UI V2: text color of search input area | yes | | |
| DesktopSearchBackgroundColor | #f5f5f5 | #<rgb> | Modern UI V2: background color of search input area | yes | | |
| DesktopSearchIconColor | #616161 | #<rgb> | Modern UI V2: Color of search icon | yes | | |
| DesktopSortIconColor | #616161 | #<rgb> | Modern UI V2: Color of sort icon | yes | | |
| DesktopURI | (unset) | string | Modern UI V2: URI of the CustomerDesktop. If set, ucdesktop... | no | | |
| LargeApplicationIcons | 0 | 0,1 | Control Panel/starter shows 32x32 app icons instead of 16x16 | no | | |
| NotifyNewWLAN | false | true,false | Popup WLAN profile editor if an unknown WLAN is detected and client is offline | no | | |
| ShowControlPanelIcon | true | true,false | UCDesktop: Visibility of legacy Control Panel Icon | yes | | |
| EnableSystemBar | false | true,false | Use elux systembar instead of mate-panel | no | | |
| KioskMode | 0 | 0,1,2 | If appliance mode is not 0 the client is locked down and only the configured appliance mode application can be used. To configure the application see kioskmode.ini. 0=none, 1=ucselfservice, 2=browser | yes | | |
| EnableConfigurationPanel | true | true,false | Whether configuration panel is available for the user or not | | | |
| SortConfigurationPanel | true | true,false | Sort segments of configuration panel (ascending) | | | |
| (live info in systembar, unnamed) | (unset) | true,false | Whether live information is available in systembar or not | | | |
| ClientBackgroundImage | (unset) | string | URL for background image on primary screen. Since 6.8: URL can be either local path, file, or http/https. Fallbacks: NonPrimaryBeforeLogin → PrimaryBeforeLogin → NonPrimary → Primary; PrimaryBeforeLogin → Primary; NonPrimary → Primary; Primary. If empty BackgroundColor is used. if BackgroundColor is our default color the eLux default background image is used. | | | |
| ClientBackgroundImageNonPrimary | (unset) | string | since 6.8: URL for background image on all non primary screen. URL can be either local path, file, or http/https | | | |
| ClientBackgroundImageBeforeLogin | (unset) | string | since 6.8: URL for background image on primary screen before user is logged on. URL can be either local path, file, or http/https | | | |
| ClientBackgroundImageNonPrimaryBeforeLogin | (unset) | string | since 6.8: URL for background image for all non primary screens before user is logged on. URL can be either local path, file, or http/https | | | |
| ScreenSaverCustomLockImage | (unset) | string | since eLux7: Local path to background image to be used for the screensaver's lock screen | | | |
| SystembarPosition | 0 | 0,1 | since 6.8: 0=Bottom, 1=Top | | | |
| SplashWaitForAppAutostart | true | true,false | If a storefront or avd is configured with the autostart delay 0s, the loading screen ucsplash is kept open until the store loads its children. The loading screen will be closed automatically after 10s as a fallback. | | | |
| EnableFloatingNotifications | true | true,false | since eLux7 (7.2503.0): Whether the system floating notifications should be shown or not. The mirroring banner, authentication dialog and notification panel are not part of the floating notifications and therefore not controlled by this boolean. | | | 7.2503.0 |

## [Screen]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| Resolution | (unset) | 1024x768 | Screen resolution | no | | |
| Frequency | (unset) | 60 | Screen frequency | no | | |
| ColorDepth | 16 | 8,16,24 | Color depth of the screen | no | | |
| LANG | en_US | de_DE | Specifies the desktop language | no | | |
| ManagerResolutions | blank | comma-separated list of resolutions | Requires NoDDC=true, to override list 'ResolutionsAvailable' via Scout. Example: 1024x768,1280x1024,1920x1080 | no | | |
| ResolutionsAvailable | generated | | This list is displayed by the starter. Depends on hardware/graphic driver | no | | |
| FrequenciesAvailable | generated | | This list is displayed by the starter. Depends on hardware/graphic driver | no | | |
| DeviceResolutions | internal use | comma-separated list of resolutions | Depends on hardware. Can be predefined by the Device-Script, if empty DefaultResolutions is used instead. | no | | |
| DefaultResolutions | blank | comma-separated list of resolutions | Predefined list of resolutions from UniCon. Is active if NoDDC=true. | no | | |
| setMy | internal use | | | no | | |
| BusID0 | internal use | | Depends on hardware | no | | |
| BusID1 | internal use | | Depends on hardware | no | | |
| BusID2 | internal use | | Depends on hardware | no | | |
| BusID3 | internal use | | Depends on hardware | no | | |
| MaxScreens | generiert | 1,2,4 | Anzahl der möglichen Bildschirme (number of possible screens). Depends on hardware/graphic driver | no | | |
| MoreModules | (unset) | | enables different driver for devices of same family | no | | |
| HWCursor | blank | blank,true,false | force usage of HWCursor | no | | |
| DacSpeed | (unset) | | overrule DacSpeed (i810) | no | | |
| SetDacSpeed | (unset) | | | no | | |
| Device | internal use | Identifier of Graphic Device | Internal name of the display device driver | no | | |
| DeviceID | internal use | pci device id | Depends on hardware | no | | |
| SubDevice | internal use | | Subclass of graphic device. Depends on hardware | no | | |
| CanRotate | 0 | 0,90,180,270 | Ob und welche Gradzahl die Grafikkarte den Bildschirm drehen kann (whether/which rotation degree the graphics card can rotate the screen). Depends on hardware/graphic driver | no | | |
| PrependUserPath | (unset) | true,false | Specifies whether defined font paths are to be evaluated prior to the system paths. | no | | |
| FontPath%d | (unset) | | additional User Font path | no | | |
| ScreenSaverOff | false | true,false | Specifies whether the power-save mode of the screen (screensaver) is to be switched on. | no | | |
| StandbyTime | 10 | #min | Specifies the time in minutes after which the Monitor is put in Standby Mode (DPMS). | no | | |
| SuspendTime | (unset) | #min | Specifies the time in minutes after which the Monitor is put in Suspend Mode (DPMS). Default: $StandbyTime | no | | |
| OffTime | (unset) | #min | Specifies the time in minutes after which the Monitor is powered off (DPMS). Default: $StandbyTime | no | | |
| BackingStore | (unset) | on,off | Optimization for graphical presentation at the client. | no | | |
| BellVolume | 0 | 0-100 | keyboard beep | no | | |
| BellPitch | 400 | 0-??? | tone | no | | |
| BellDuration | 100 | 0-??? | in ms | no | | |
| Rotate | (unset) | one of the values from 'CanRotate' | Specifies the level of rotation of the screen contents. | no | | |
| NoDDC | (unset) | true,false | Specifies whether to value the monitor information. | no | | |
| XkbModel | K293 | K293,K235,TYPE6 | from [Keyboard]→Model | no | | |
| XkbLayout | de | | Specifies the keyboard language | no | | |
| XkbVariant | internal | string | handles 'DeadKeys' by setting XKB variant | no | | |
| XkbOptions | <empty> | string | special XKB Options, e.g. on russian layout: "grp:toggle" | no | | |
| XkbCompat | <empty> | string | special XKB Compat Mode, e.g. on bulgarian layout: "group_led" | no | | |
| LeftHandMouse | (unset) | empty,LeftHandMouse | Specifies whether to swap left and right hand mouse button. | no | | |
| Emulate3Buttons | (unset) | empty,Emulate3Buttons | Specifies whether 3 buttons are to be emulated. | no | | |
| multiClickTime | 500 | | Double click speed | no | | |
| Buttons | auto | auto,none,2,3,5 | Specifies the mouse type. auto=automatic detection, none=NoMouse, 2=Two button mouse, 3=Three button mouse, 5=Wheel mouse | no | | |
| PointerProtocol | auto | auto,none | Controls whether mouse cursor is shown or not | no | | |
| Numlock | on | on,off | Initial numlock state | no | | |
| DontVTSwitch | false | true,false | Specifies whether Ctrl Alt F1...F12 should be enabled to switch between the consoles. | no | | |
| DeadKeys | (unset) | on,off | Specifies whether dead keys should be enabled. | no | | |
| PointerSpeed | 10/10 | string | Mouse pointer speed | no | | |
| KeyboardDelay | 500 | # | Keyboard delay | no | | |
| KeyboardSpeed | 30 | # | Key repetition rate | no | | |
| Monitor2Position | Right | Left,Right,Above,Below | Position relative to Monitor1: one of "Left","Right","Above","Below" | no | | |
| Monitor1,Monitor2,Monitor3,Monitor4 | internal | string | Links the outputs (xrandr 1.2) with the monitor sections. Only supported by certain graphics drivers (intel) | no | | |
| DefaultMonitor2Position | "Right" | {"Right","Left"} | | no | | |
| AccelMethod | XAA | XAA,EXA | The selection is only supported by individual graphics drivers (intel) | no | | |
| Enable_YCable | true | true,false | Entscheidet ob die Kabelpeitsche unterstützt wird. Achtung: Wenn VGA-DVI Adapter verwendet wird, kann es zu einem weiteren Monitoreintrag kommen. (Decides whether the Y-cable/cable-splitter is supported. Warning: when a VGA-DVI adapter is used this can result in an additional monitor entry.) | no | | |
| OutputProviderId | (unset) | string | If a device with multiple GPUs is detected all GPUs are activated; the primary GPU is auto detected if the autodetection does not work the id can be overwritten here | no | | |
| Radeon.Audio | true | true,false | False=fix DP port out of range, true=enable audio over DP port. | yes | | |
| IgnoreMonitorDisableEvent | false | true,false | ONLY RP5. If set to true traycrtl does ignore monitor disconnect events. For the calculation of the virtual framebuffer size and monitor position the disconnected monitor is processed as connected. | no | | |
| VerticalAlignment | bottom | top,bottom | RP5 >= 5.7.2001 or RP6 >= 6.9.0: If VerticalAlignment is set to "top" the old behavior is forced where the monitors are aligned at the top right corner. If set to "bottom" the new behavior is forced where the monitors are aligned at the bottom right corner. | | | |
| HorizontalAlignment | left | left,center,right | RP6 >= 6.2209: left=old behavior, displays aligned by left display side; center=align displays horizontally by center of max row width; right=align displays by right display side. | | | |
| TouchpadState | on | on,off,auto | on=Touchpad enabled, off=Touchpad disabled, auto=Automatically disables the touchpad when an external mouse (e.g. USB mouse) is connected. | | | |
| AutomaticLayoutAdjustment | true | true,false | eLux7 < 7.2409.0, Obsolete since 7.2409.0 Beta1, behavior is as if the parameter is always true. If true the monitor layout will be adjusted automatically if a monitor is disconnected. Disconnect can also happen if a DP monitor is turned off. Primary monitors and windows can be moved around to make sure all content is visible. If false the monitor layout will stay potentially with gaps and windows in invisible areas | no | | |
| DisableVSync | false | true,false | RP6>=6.2204 and RP6==6.2104.2001. Warning: This setting might lead to screen tearing or other graphical errors. Setting this to true will disable VSync for the GPU(s) which will usually drastically increase FPS. Can be useful to work around bugs in xorg regarding multi-GPU screen stutter issues. | | | |

## [UpdateInfo]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| ftphost | empty | | IP address of the server for the update. | no | | |
| ftphostname | empty | | IP name of the server for the update | no | | |
| ftppath | empty | | The path at the update server | no | | |
| user | empty | | The user to be authorised at the server | no | | |
| password | empty | | The password for authorisation at the server | no | | |
| idf | empty | myimage.idf | The name of the image file | no | | |
| UseHttp | true | true,false,file | Specifies whether the update is to be processed via HTTP, FTP or File. | no | | |
| CheckCertificateValidity | (unset) | true,false | Enable TLS certificate checking for all updates. If CheckCertificateValidity=true, updates via HTTPS will fail if necessary CA certificates are not installed on eLux client. | yes | Update | 7.2411.0 |
| ProxyType | 0 | 0=None,1=Static consumer,2=Static provider,3=Dynamic | Defines the type of proxy to be used. | | | |
| ProxyServer | empty | | IP address of the proxy server for the update | no | | |
| ProxyServerName | empty | | IP name of the proxy server for the update | no | | |
| ProxyServerPort | empty | | Port of the proxy server | no | | |
| AutoCheckUpdate | false | true,false | Check for update during the start of the client (Update on boot) | no | | |
| CheckUpdateOnShutdown | false | true,false | Specifies whether it is to be checked for an update during the shutdown of the client. | no | | |
| ConfirmUpdate | true | true,false | Specifies whether the client user is to confirm an update. One-shot during updates | no | | |
| ActUpdateResult | 0 | # | Update initiated from Scout. Internal parameter during update. **Removed in eLux 7** (moved to updatestate.ini in eLux 7) | no | | <7.0.0 |
| ActIDF | (unset) | string | Currently installed idf file | no | | |
| ManagerUpdate | false | true,false | Update initiated from Scout. Internal parameter during update. | no | | |
| AllowIdfBrowse | false | true,false | Starter/Setup/Firmware: Browse button for all IDF files on the web server. Browsing must be enabled on the web server. | no | | |
| UseUpdatePartition | empty | true,false | All update packages are loaded. Internal parameter during update. **Removed in eLux 7** | no | | <7.0.0 |
| Deferred | empty | true,false | User has deferred | no | | |
| MaxDeferments | empty | count | Maximum deferment possible | no | | |
| (deferment-times list, unnamed) | (unset) | 1,2,30,... | List of deferment times in minutes | no | | |
| (deferment-count-running, unnamed) | (unset) | int | Which deferment count is running | no | | |
| (current update state member, unnamed) | (unset) | transfer,transferred,error,done | Member of current update state, used for restart transfer. **Removed in eLux 7** (moved to updatestate.ini in eLux 7 and renamed to CurrentState) | no | | <7.0.0 |
| AtId | empty | int | Current at command id. | no | | |
| ClearUpdatePartition | empty | true,false | Clean update partition after successfully installation. | no | | |
| MaxUpdateRetry | 3 | count | Maximal update retry on error, if AutoCheckUpdate on boot is on. Only without user confirmation | no | | |
| LastArch | empty | EFI,x64 | Last system architecture from __BM__ macro check, internal use only. **Removed in eLux 7** | no | | <7.0.0 |
| Mdf | rp6.mee | | Migration definition file (RP5→RP6) located in the RP6 container | no | | |
| SecurityOptions | 0 | int | 0=no signature check, 1=check idf signature, 2=check package signatures, 3=check idf and package signatures | | | |
| LockCancelTimeout | 30 | int | Timeout in seconds where a user can cancel the update lock dialog (used if device is currently serving as dynamic proxy provider or a delivery is in progress). **Removed in eLux 7** | | | <7.0.0 |
| ServerForVPN | empty | <protocol>://<server> | Url prefix (protocol and server) for the update in case of vpn | no | | |
| FormatBeforeUpdate | false | true,false | Controls update with flash format feature. One-shot during updates | no | | |
| PartitionResizing4GB | true | true,false | The repartitioning is only executed if a corresponding parameter is set | yes | | 6.2302.2000 |
| ForceUpdateOnBoot | false | true,false | Forces an update on boot; gets set in the update scripts (init.update) if we need to reformat the disks when coming from a kernel older than 5.4.28.7. Formatting will clear the parameter. **Removed in eLux 7** | | | <7.0.0 |
| (inform user before update on boot, unnamed; Scout setting) | true | true,false | Scout setting: inform the user before update on boot | | | 6.2209.0 (EL-7510) |
| (inform user for n seconds, unnamed; Scout setting) | (unset) | int | Scout setting: inform the user for this many seconds | | | 6.2209.0 (EL-7510) |
| UpdateOnBootUserCanCancel | false | true,false | Scout setting: allow the user to cancel/postpone the update | | | 6.2209.0 (EL-7510) |
| UpdateOnBootFormat | false | true,false | Scout setting: do a flash format if performing an update via boot | | | 6.2209.0 (EL-7510) |
| SysPartToggle | true | true,false | Deactivates toggling the system partition during update when set to false ("Speed Update"), even on devices with >=16 GB of disk size | | Update | 7.0.0 |
| MigrationIdfUrl | empty | any valid url string | Custom parameter for the migration RP6→eLux7 or eLux 7.2408.*→eLux >= 7.2409.0. Only present in migration_enablement epm. Not added to ucsettingsd. This key contains a url to a target elux7 idf the system should migrate to. The procedure that uses this key is described in "Migration for eLux 7 for developers". | yes | Not present in data model | 6.2104.300x, 6.2104.400x, 6.2209.x, 6.2302.x, 7.2408.x (ELUX-141) |
| MigrationServerForVpn | empty | <protocol>://<server> | Custom parameter for the migration RP6→eLux7 or eLux 7.2408.*→eLux >= 7.2409.0. Only present in migration_enablement epm. Not added to ucsettingsd. Same as ServerForVPN key but affects MigrationIdfUrl instead. | yes | Not present in data model | same as MigrationIdfUrl (ELUX-141) |
| AutoStartMigration | empty | true,false | Custom parameter for the migration RP6→eLux7 or eLux 7.2408.*→eLux >= 7.2409.0. Only present in migration_enablement epm. Not added to ucsettingsd. Configures if the migration should start automatically on boot after installation of the epm or if a custom trigger is needed. See "Migration eLux RP6 to eLux7 for Developers". | yes | Not present in data model | same as MigrationIdfUrl (EL-9428) |
| (do not reboot after installation, unnamed) | true | true,false | Do not reboot after installation | | | 7.2601 (ELUX-3396) |
| ShowNotificationOnDelivery | true | true,false | Allow showing system notifications during delivery (info, warning, failure) | | Update | 7.2605.0 and 7.2603.1000 |
| ShowNotificationOnUpdate | true | true,false | Allow showing system notifications during update (info, warning, failure) | | Update | 7.2605.0 and 7.2603.1000 |
| ShowNotificationOnUefiUpdate | true | true,false | Allow showing system notifications during UEFI update (info, warning, failure) | | Update | 7.2605.0 and 7.2603.1000 |
| DeliveryBatteryThreshold | 50 | 0..100 | Minimum battery charge allowed to perform delivery | | Update | 7.2605.0 and 7.2603.1000 |
| UpdateBatteryThreshold | 50 | 0..100 | Minimum battery charge allowed to perform update | | Update | 7.2605.0 and 7.2603.1000 |
| UefiUpdateBatteryThreshold | 50 | 0..100 | Minimum battery charge allowed to perform UEFI update | | Update | 7.2605.0 and 7.2603.1000 |

> Honesty flag: several rows had blank Parameter cells (deferment-times list, deferment-count-running,
> current-update-state member, inform-user-before-update-on-boot, inform-user-for-n-seconds,
> do-not-reboot-after-installation). Preserved with full description; excluded from generated schema.

## [Security]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| LocalPassword | elux | crypted string | The password is used in the base configuration only. **Deprecated in 2018, removed in eLux 7** | no | | <elux7.0.0 |
| ADPasswordUTF8 | false | true,false | Send AD password as UTF8 (required by Win7 ADS), otherwise passwords containing Umlaute will fail | no | | |
| AllowX11Clients | false | true,false | Specifies whether other clients are allowed to open windows on this client. | no | | |
| Mirror | false | true,false | Specifies whether the mirroring server is started. | no | | |
| MirrorViewOnly | true | true,false | Specifies whether the mirroring client is authorized for viewing only. | no | | |
| MirrorDialog | true | true,false | Specifies whether initiating a mirror session has to be confirmed at the client. | no | | |
| MirrorDMCP | true | true,false | Specifies whether XDMCP sessions are to be mirrored, too. | no | | |
| MirrorPassword | empty | | Password for the mirroring process. | no | | |
| MirrorTLS | false | true,false | aes 256 Bit encryption for vncserver | no | | |
| MirrorDisplays | empty | 1,2,3,... | Monitors to be shared by the mirroring server | no | | |
| SCAuthType | 0 | 0,1,2,3,4,5,6,7,10,11,12,13,14,15 | Type of authorisation: 0=off, 1=WinNT Domain (SMB), 2=LDAP (unused), 3=Active Directory Domain (ADS), 4=LDAP+Smartcard (Cert.) (unused), 5=ADS+SmartCard (Cert.), 6=Secude (SmartCard Cert. w/o ADS), 7=Smarty+ADS — both not available in RP6 or eLux7, 10=Evidian, 11=EntraID (since eLux7 Alpha 36), 12=OpenID (since eLux 7.2411.0), 13=Citrix (since eLux 7.2503.0, ELUX-3535), 14=Imprivata, 15=SAML. | no | | |
| AuthType | 0 | 0,1,2,3,5,6,7,10,11,12,13,14 | same as SCAuthType | no | | |
| AuthServer | empty | | Authorisation server | no | | |
| AuthBase | empty | | LDAP Search Base (AuthType: 2,3,4,5,7) | no | | |
| AuthVersion | empty | 2,3 | LDAP Protocol Version. LDAP: 2 or 3, ADS: 3 only | no | | |
| AuthDomain | empty | | SMB Domain or IP/ADS Domain | no | | |
| AuthPDC | empty | | 1st AuthServer for SMB | no | | |
| AuthBDC | empty | | 2nd AuthServer for SMB | no | | |
| AuthBindDN | empty | | if LDAP query requires authentication | no | | |
| AuthBindPW | 0 | | if LDAP query requires authentication | no | | |
| AuthDomainFieldStatus | 0 | 0,1,2 | Specifies how the domain field is to be displayed at the client. 0=enabled, 1=disabled, 2=invisible | no | | |
| AuthDomainADS | empty | | Overwrite the domain evaluated from AuthServer value. | no | | |
| AuthShowLastUser | false | true,false | Specifies whether the user, who has logged in last, is to be shown at the client. | no | | |
| AllowScUserAuth | (unset) | true,false | Enables to change from SmartCard-Authentification to AD-Authentification (User, Password, Domain) via [Esc]-Key | no | | |
| PureAuthLogin | false | true,false | Enables PureAuths authvr5 loopback server for unlocking and custom login user agent. | | | |
| BrowserTrustedUris | <empty> | comma separated uri list | Exports trusted uris list into gss api and enables kerberos authentication with these urls | | | |
| ScUserAuthAsDefault | false | true,false | Determines whether the AD-Auth dialog should be displayed as default even if SmartCard-Auth is available. Only to be evaluated if AllowScUserAuth is set to true. | | | |
| ScInitialPIN | false | # | Initial PIN for Smarty. Must be changed in the first login dialog. | no | | |
| Pkcs11CaCerts | <mandatory> | <filenames..> | Name der Datei mit dem Zertifikat der Zertifizierungsstelle (Root Zertifikat). Liste mit Blank getrennt. (Name of the file with the CA certificate. List separated by blank.) | no | | |
| Pkcs11CaCrls | online | <filenames...> or 'none' | "" := (online) Die CRL distribution points werden aus dem Benutzerzertifikat gelesen. Die CRL wird online gelesen und geprüft. Es werden 'ldap:' und 'http:' URLs unterstützt. 'none' := keine CRL Prüfung (CRL distribution points read from user certificate; checked online; ldap: and http: URLs supported; 'none' = no CRL check) | no | | |
| PamPkcs11Module | empty | <filename> | (full path-)Name der PKCS#11 Bibliothek. Der default wird durch [pkcs11]Active bestimmt. (full-path name of PKCS#11 library; default determined by [pkcs11]Active) | no | | |
| PKcs11CrlPolicy | auto | auto,none,offline | intern → pam_pkcs11.conf, pkcs11_eventmgr.conf | no | | |
| UseServerProfile | empty | true,false | Specifies whether the client data are to be saved on a server. | no | | |
| ServerProfilePath | none | | The path in which the server profile is stored. | no | | |
| Check | (unset) | none,forever,boot | Specifies when to check the SmartCard. boot=SmartCard is checked for during the boot procedure of the client. forever=The SmartCard must always be available. | no | | |
| LockedFields | (unset) | | Bit string for the fields which are to be locked at the client. | no | | |
| (Parameter für ldap.conf — siehe manpage: ldap.conf, pam_ldap; no single key, this is a section-divider note in the source, not a parameter row) | | | | | | |
| Krb5SrvLookup | false | boolean | kdc in krb5.conf eintragen, oder soll die Bibliothek dynamisch per DNS danach suchen (whether to enter kdc in krb5.conf, or have the library search dynamically via DNS) | no | | |
| Krb5LargeMessageSize | 1400 | integer | ab welcher Paketgröße wechselt die Bibliothek von UDP auf TCP (packet size threshold at which the library switches from UDP to TCP) | no | | |
| Krb5KpasswdProto | udp | tcp,udp | mit welchem Protokoll wird das PE:changepassword schickt. Hintergrund: RFC 3244 - Microsoft Windows 2000 Kerberos Change Password and Set Password Protocols | no | | |
| Krb5Win2k | yes | yes,no | Dieser Parameter setzt den pkinit_win2k Parameter in /etc/krb5.conf, see man krb5.conf. Er ist nur bei SmartCard anmeldung relevant. Wenn der Parameter auf aktiv ist, kann man sich an Windows 2000 und 2003 Domänen anmelden. Zur Anmeldung an 2008R2 muss der Parameter auf no gesetzt werden. | no | | |
| Krb5EnterpriseMode | false | boolean | Darf im Username ein '@' enthalten sein. Beispiel: MS-UPN ist Siegbert.Teuscher@unicon-software.com, die Realm ist W2K3.UNICON-KA.DE. Dann ist der volle Kerberosname: Siegbert.Teuscher\@unicon-software.com@W2K3.UNICON-KA.DE | no | | |
| Krb5LogLevel | - | string | see: man krb5.conf. Der Parameter wird, abhängig von LogLevel automatisch auf "-3" oder "0-" gesetzt | no | | |
| PamPkcs11IgnoreSlotMode | Description | Description,Label | Wogegen wird der String PamPkcs11IgnoreSlot verglichen? Die Slot Description entspricht dem Namen des Readers. Der Label dem Label, das beim initialisieren der Smartcard angegeben wurde. | no | | |
| (PamPkcs11IgnoreSlot value, unnamed) | (unset) | string | Wenn der String im Reader-, Karten-Namen auftaucht, wird dieser Reader/diese Karte ignoriert sowohl vom PKCS11 EventManager wie auch von der Kerberos Bibliothek | no | | |
| Krb5TicketLifetime | 36000 | integer [seconds] | see: man krb5.conf - ticket_lifetime | no | | |
| Krb5RenewLifetime | <Krb5TicketLifetime> | integer [seconds] | see: man krb5.conf - renew_lifetime | no | | |
| LdapReferrals | true | | see: man ldap.conf - Referrals | no | | |
| LdapRestart | true | | see: man ldap.conf - Restart | no | | |
| LdapScope | sub | | see: man ldap.conf - Scope | no | | |
| LdapTlsReqcert | never | | see: man ldap.conf - TLS_REQCERT | no | | |
| LdapTlsCrlcheck | none | | see: man ldap.conf - TLS_CRLCHECK | no | | |
| pam_filter | "" | | see: man pam_ldap - pam_filter | no | | |
| pam_groupdn | "" | | see: man pam_ldap | no | | |
| pam_member_attribute | uniquemember | | see: man pam_ldap | no | | |
| pam_min_uid | 0 | | see: man pam_ldap | no | | |
| pam_max_uid | 0 | | see: man pam_ldap | no | | |
| pam_password | AuthType 3,5 except AuthType 1,4: crypt | | see: man pam_ldap | no | | |
| pam_login_attribute | AuthType 3,5: sAMAccountName; AuthType 1,4: uid | | see: man pam_ldap | no | | |
| pam_sasl_mech | AuthType 3,5: GSSAPI; AuthType 1,4: "" | GSSAPI,GSS-SPNEGO | see: man pam_ldap | no | | |
| WriteFilter | 1 | 0-2 | 0=Schreibfilterzustand unbekannt (write filter state unknown), 1=Schreibfilter aus (write filter off), 2=Schreibfilter aktiv (write filter active) | no | | |
| Scoutd | false | true,false | Specifies whether scoutd is started and client is accessible via exterm on port 5681 | no | | |
| MirrorDashboard | false | true,false | Specifies whether the websockify daemon is started. | yes | | |
| MirrorDashboardCertificate | (unset) | string | Path to the ssl certificate which is used by websockify if MirrorTLS is true | yes | | |
| MirrorDashboardPrivateKey | (unset) | string | Path to the ssl private key file which is used by websockify if MirrorTLS is true | yes | | |
| Krb5WeakCrypto | false | true,false | Set allow_weak_crypto to true or false in krb5.conf | no | | |
| TlsVerifyOption | -1 (eLux >= 7.2505.0), 0 | -1,0,1,3 | Specify trust level for eLux/Scout management protocol: -1=Scout certificate is not verified (eLux >= 7.2505.0); 0: Scout certificate verified if Scout CA certificates sent to eLux, otherwise Scout certificate is not verified (eLux >= 7.2505.0) / Scout certificate is not verified (eLux <= 7.2503.0); 1=Scout certificate is verified, required certificates located in /setup/cacerts/scoutsrv; 3=in addition to 1 the Scout hostname must be identical with certificate's subject CN or SAN | yes | | |
| ScoutCaElprotCertFirstSeenAt | 0 | timestamp (time_t) | Date/Time when Scout CA was first sent to eLux client. After eLux has received a Scout CA certificate (i.e. once ScoutCaElprotCertFirstSeenAt > 0), eLux will check TLS certs unless disabled (TlsVerifyOption = -1). | no | | |
| Info1 | (unset) | | Free text info to specify client specific information (f.e. location, room, division) | | | |
| Info2 | (unset) | | Free text info to specify client specific information (f.e. location, room, division) | | | |
| Info3 | (unset) | | Free text info to specify client specific information (f.e. location, room, division) | | | |
| DisableSecurePin | false | true,false | Since 6.4.1: If set to true secure pin login is disabled in loginmanager | | | |
| CryptSetupPartition | false | true,false | **Deprecated since 6.10.0**, please use DiskEncryption instead. **Removed in eLux 7.0.0.** To be backward compatible this parameter will still work but has the same effect as DiskEncryption. Since 6.7.0: If set to true the setup partition will be encrypted on next reboot of device. If set to false setup partition will be decrypted on next reboot. TPM2 is used to store the key for encryption, no user input is needed. | | | |
| EncryptedSetup | empty | false,true | **Removed since 6.10.0**, it will be available in Security DataModel but not in terminal.ini because value is gathered on each boot. Status if setup partition is encrypted | no | | |
| DiskEncryption | false | true,false | **Since 6.10.0**: If set to true disk encryption will be used. Root and Setup partition will be encrypted | | | |
| Licence | (unset) | true,false | Indicates whether eLux is licensed (RP5 only). **Removed in eLux 7.2411.0** | | | <7.2411.0 |
| BrowserSandboxed | false | true,false | If set to true the internal browser will be started in a sandbox only. In this case the firejail package must have been installed. | | | |
| DisableLdapSearch | false | true,false | During Login disables a LDAP search to find User variables. This setting was introduced with EL-8916. It is a workaround for Europcar, eLux7 receives a proper solution and thus has not this setting. | | | Since 6.2303.3000, not in eLux7 |
| DesktopLockStore | empty | | When AuthType=Citrix (13) then this is used by CWA to launch a locked down session. e.g.: https://vad72203.itsr.qa.unicon-ka.de/Citrix/vad72203ItsrStore | | | 7.2503.0, ELUX-3535 |
| DesktopLockResource | empty | | When AuthType=Citrix (13) then this is used by CWA to specify the resource to be used. Optional. e.g.: Controller.auto2203w10-1$A10-3-6E7F2AFD-0001 | | | 7.2503.0, ELUX-3535 |
> The following keys belong to the `[LicenseInfo]` section (own top-level section per the older
> doc's table of contents, not part of `[Security]`):

## [LicenseInfo]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| ProductLeases | (unset) | | Comma separated list of licensed thirdparty product ids | no | Security | 7.2411.0 |
| LicenseValid | (unset) | true,false | Indicates whether eLux is licensed | no | Security | 7.2411.0 |
| SubscriptionValid | (unset) | true,false | Indicates whether subscription is valid | no | Security | |
| IssuedAt | (unset) | | Time of lease issue | no | Security | 7.2411.0 |
| EndOfLeases | (unset) | | End of lease | no | Security | |
| EndOfSubscription | (unset) | | End of subscription | no | Security | |

> Honesty flag: many German-language source rows (Kerberos/PKCS11/LDAP internals) are
> transliterated with an English gloss in parentheses for clarity — original German text preserved
> verbatim followed by translation. MirrorPassword, MirrorTLS, MirrorDisplays, AllowScUserAuth,
> PureAuthLogin, LockedFields, and Krb5SrvLookup were all resolved by cross-checking the older
> `eLux terminal.ini.pdf` reference (same pattern as [Global]/[Network] above) — confident reads.
> `allow_weak_crypto flag` is resolved as `Krb5WeakCrypto` per the same cross-check. The
> PamPkcs11IgnoreSlot *value* row (as opposed to PamPkcs11IgnoreSlotMode, which is named) still has
> a blank Parameter cell in both source PDFs and remains excluded. The licensed-thirdparty-product-
> ids row is resolved as `ProductLeases` (see `[LicenseInfo]` cross-check below) and the section
> itself is corrected from being folded into `[Security]` — the older doc's table of contents shows
> it as its own top-level `[LicenseInfo]` section, which this transcription now also uses (see
> renamed section after `[Security]` below).

## [Multimedia]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| MasterVolume | 49 | # | Master volume | no | | |
| PCMVolume | 24 | # | PCM volume | no | | |
| XDMCPSound | false | true,false | Specifies whether sound is to be available in XDMCP sessions. | no | | |
| MicVolume | 80 | # | The microphone volume | no | | |
| MicMute | true | true,false | The muting of the microphone | no | | |
| VolumeMute | false | true,false | The muting of the volume (speakers) | no | | |
| PulseAudio | system | system,session,off | Specifies how Pulse Audio System is running. | no | | |
| IgnoreAsDefault | (unset) | comma separated list () of <vendorId>:<productId> | Comma separated list of usb audio devices (vendorId:productId) which are not automatically set as default if connected. Wildcard allowed for productId (vendorId:*). Do not add blanks between devices (no blank after comma). Example: IgnoreAsDefault=1188:03cf,1188:1234 or IgnoreAsDefault=1188:* | | Audio | 6.2302.1000 |

## [NetDriveList]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| 1 | (unset) | | The key number must match with the # of the [!NETDRIVE!#] section | no | | |
| 2 | (unset) | | (same pattern as key 1) | no | | |

## [!NETDRIVE!#]

> Section name uses literal `#` placeholder, e.g. `[NETDRIVE1]`, `[NETDRIVE2]`, ...

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| Directory | (unset) | | Specifies which directory provides the access to the data. | no | | |
| Server | (unset) | servername | Server, where the network drive is shared. | no | | |
| User | (unset) | | User for the authorisation at the server | no | | |
| Password | (unset) | | Password for the authorisation at the server. | no | | |
| Share | (unset) | \\\\server\\freigabe | Share name at the server | no | | |
| UseKerberos | (unset) | true,false | Specifies whether authorisation has to be done by certificate. (Requires that the security settings define ADS as authorisation method.) | no | | |

> Honesty flag: Directory, Server, and User were resolved by cross-checking the older
> `eLux terminal.ini.pdf` reference — confident reads, not inferred.

## [Printd]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| port_usb | 9101 | # | Port number for the USB print | no | | |
| port_lp | 0 | # | Port number for the LP print, if 0 the direct print is disabled | no | | |
| port_lpsave | 9100 | # | Port number for the LP print (save) | no | | |

## [PrinterList]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| 1 | (unset) | PrinterName1 | List of defined printers | no | | |
| 2 | (unset) | PrinterName2 | The key number must match with the # of the [!PRINTER!#] section | no | | |

## [!PRINTER!#]

> Section name uses literal `#` placeholder, e.g. `[PRINTER1]`, `[PRINTER2]`, ...

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| Name | (unset) | PR-Lexmark | | no | | |
| Type | (unset) | net,par,ser,usb | The printer type: net=network printer, par=printer at parallel port, usb=printer at the USB port, ser=printer at a serial port | no | | |
| Address | (unset) | printer1.my.org | The network address of the printer (only for type=net, then mandatory) | no | | |
| Queue | (unset) | queue1 | The name of the printer queue (only for type=net, then mandatory) | no | | |
| TpClass | (unset) | | The name of the ThinPrint class | no | | |
| Default | (unset) | true,false | Specifies whether this printer is to be the default printer. | no | | |
| Com | (unset) | 0 | The number of the COM port which is to be printed on. Always set to 0 | no | | |
| Baud | (unset) | 0,1200,2400,4800,9600,19200,38400 | The baud rate. If set to 0, the value from the hardware settings is used. | no | | |
| TextFilter | (unset) | true,false | Specifies whether a text filter is to be used. | no | | |
| PclFilter | (unset) | true,false | Specifies whether a PCL filter is to be used. | no | | |
| Driver | (unset) | | Specifies whether the driver name for this printer. | no | | |
| Tp | (unset) | true,false | Specifies whether the printer is to be defined as ThinPrint printer. | no | | |

## [Hardware]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| Device | (unset) | none,intern,extern,usb | Specifies the type of the Smart-Card devices. | no | | |
| Flash | (unset) | | Technical description of flash storage, written by /etc/init.d/detect-hw, setting required | no | | |
| ScreenLayout | 39539 | | Specifies the number of monitors to be used. | no | | |
| RamdiskPercent | (unset) | | Specifies the size of the RAM disk at the client (in %). | no | | |
| USBUserInfo | true | true,false | Specifies whether the user is to be informed about USB mass storage devices when being mounted or dismounted. | no | | |
| Media | (unset) | ethernet,adsl,isdn,modem,tokenring,wavelan | Specifies which network media the client is to use for connection. | no | | |
| Speed | (unset) | auto,100HD,100FD,10HD,10FD,1000,BNC,AUI | Network speed in case of setting 'ethernet' or 'adsl'. Same `Speed` key is reused with value range 4,16,100,auto for 'tokenring' and 1200,2400,3600,4800,9600,14400,19200,28200,38400,57600,115200 for 'modem' (per the older terminal.ini.pdf, these are continuation/enum rows of the same `Speed` parameter, not separate keys). | no | | |
| ESSID | (unset) | | | no | | |
| Channel | (unset) | | | no | | |
| WPAMode | (unset) | WEP,WPA,WPA2,WPA2-EAP,IEEE8021X | Mode in case of setting 'wavelan'. WEP=WEP, WPA=WPA(PSK), WPA2=WPA2(PSK), WPA2-EAP=WPA2(EAP), IEEE8021X=IEEE 802.1X(LEAP) | no | | |
| WPAIdentity | (unset) | | | no | | |
| NetworkName | (unset) | | | no | | |
| Mode | auto | | Tokenring mode | no | | |

## [HwInfo]

> Values are updated when booting

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| BIOS | (unset) | | | no | ucsettingsd, Hardware | |
| Supplier | (unset) | | | no | ucsettingsd, Hardware | |
| DeviceType | (unset) | | | no | | |
| BaseboardAssetTag | (unset) | | | no | | |
| ChassisAssetTag | (unset) | | | no | | |
| Memslot... | (unset) | | | no | ucsettingsd, Hardware | |
| CPU | (unset) | | CPU Frequency | no | ucsettingsd, Hardware | |
| Kernel | (unset) | | | no | | |
| Flash | (unset) | | | no | | |
| CanSuspend | 1 | 0,1 | Indicates whether hardware supports suspend | no | | |
| HasTpm | (unset) | | | no | ucsettingsd, Hardware | |

## [Com#Settings]

> Section name uses literal `#` placeholder, can be 1 to 4, e.g. `[Com1Settings]`

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| Speed | 9600 | 1200,2400,4800,9600,19200,38400,57600,115200 | | no | | |
| Parity | none | none,even,odd | | no | | |
| FlowControl | xonxoff | none,rtscts,xonxoff,both | | no | | |
| BitWidth | 8 | 5,6,7,8 | | no | | |
| StopBits | 1 | 1,2 | | no | | |

> Honesty flag: Speed, Parity, FlowControl, and BitWidth were resolved by cross-checking the older
> `eLux terminal.ini.pdf` reference — confident reads, not inferred.

## [Environment]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| LIBVA_DRIVER_NAME | (unset) | | Disable hardware acceleration for device | | | |
| VDPAU_DRIVER | (unset) | | Disable hardware acceleration for device | | | |

## [Keyboard]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| DisableKBPowerOff | false | bool | disables power button on USB keyboard. | yes | | |
| Model | auto | K293,TYPE6,K235,K257 | | no | | |
| ForceShiftLock | false | bool | Forces CapsLock to the same behaviour as the Shift key | | | |

## [ethernet] / [wavelan] / [tokenring] / [HW-monitor]

> All four sections appear in the source table of contents with no parameter rows rendered in
> the source PDF (empty placeholder tables). No keys to transcribe.

## [USB]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| usehid | true (since usb-5.9) | bool | since BaseOS NG 1.19-2 whether to load hid or (usbkbd,usbmouse) kernel modules to support the USB input devices. | no | | |
| numbered_reports | (unset) | bool | we have a patched usbmouse, if called with param: numbered_reports=1, it will skip over an initial input-ID when reading data from the device. | no | | |

## [dconfm]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| org.mate.Marco.general:num-workspaces:int | 4 | 1..36 | Number of workspaces | no | | |
| org.mate.Marco.general:compositing-manager:bool | true | true,false | | no | | |
| org.mate.Marco.general:action-right-click-titlebar:string | menu | toggle_shade,toggle_maximize | | no | | |
| org.mate.Marco.global-keybindings:panel-main-menu:string | <Control>Super_L | <key combination> | disabled | | | |
| org.mate.Marco.global-keybindings:show-desktop:string | <Control><Alt>d | <key combination> or disabled | Show/hide desktop | | | |
| org.mate.Marco.global-keybindings:run-command-screenshot:string | disabled | <key combination> | Starts the screenshot utility to capture the whole screen, f.e. <Shift>Print | | | |
| org.mate.Marco.global-keybindings:run-command-window-screenshot:string | disabled | <key combination> | Starts the screenshot utility to capture the active window, f.e. <Shift><Alt>Print | | | |
| org.mate.Marco.general:mouse-button-modifier:string | <Alt> | <key combination> or disabled | Modifier in combination with mouse buttons to: move window (left click), resize window (middle click), show window menu (right click) | no | | |
| org.mate.Marco.general:use-focus-all-fullscreen:bool | true | true,false | 6 monitors solution for switching between several Citrix sessions; the eLux system bar moved to the foreground on RP5 images (ONLY RP5, cause side effects in RP6) | no | | |
| org.mate.interface:cursor-blink:bool | false | true,false | Cursor in input fields will blink or not | | | |
| org.mate.peripherals-touchpad:natural-scroll:bool | false | true,false | Two finger scroll direction of touch pad like Windows = true | no | | |
| org.mate.SettingsDaemon.plugins.media-keys:home:string | XF86HomePage | | Extended key binding, if set starts: caja | | | |

## [gconfm]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| /apps/metacity/general/fullscreen_mod_stacking:bool | (unset) | default:false | #bewirkt faktisch ein panel-always-on-top, auch wenn apps fullscreen sind (effectively forces panel-always-on-top even when apps are fullscreen) | no | | |
| (maximize-on-one-screen flag, unnamed) | (unset) | default:false | #maximize eines windows: maximiert nur auf einen schirm (z.b. bei dualscreen) (maximize a window only on one screen, e.g. dual-screen) | no | | |
| (unnamed gconf row, no description) | (unset) | | | no | | |
| (color value row, unnamed) | (unset) | #ffff00 | | no | | |
| /apps/metacity/general/reduced_resources:bool | (unset) | false | | no | | |
| /apps/metacity/window_keybindings/toggle_maximized:string | (unset) | | | no | | |
| /apps/metacity/window_keybindings/toggle_fullscreen:string | (unset) | | | no | | |
| /apps/metacity/window_keybindings/toggle_shaded:string | (unset) | | | no | | |
| /apps/metacity/window_keybindings/toggle_unmaximize:string | (unset) | | | no | | |
| /apps/metacity/window_keybindings/toggle_on_all_workspaces:string | (unset) | | | no | | |
| /apps/panel/toplevels/bottom_panel_screen0/hide_delay:int | (unset) | | delay for hiding the taskbar | no | | |
| /apps/metacity/global_keybindings/panel_main_menu:string | <Control>Super_L | <Alt>space | hotkey for startmenu (CTRL+WindowsKey) für FI: <Shift><Control><Alt>d | no | | |
| /apps/metacity/global_keybindings/show_desktop:string | (unset) | disabled | #durch den Eintrag wird CTRL-ALT-D deaktiviert (this entry disables CTRL-ALT-D) | no | | |
| /apps/metacity/global_keybindings/run_command_1:string | <Control> | <Alt>End | hotkey to lock the screen | no | | |

## [xscreensaver]

> See also: [Layout] UseScreenSaver, XAutoLockDelay, UseScreenSaverBeforeLogon, XAutoLockPwd

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| selected | (unset) | <any hack> | if mode==one use this graphics-hack sub-process | no | | |
| mode | (unset) | random,one,blank | Controls the behavior of xscreensaver. | no | | |
| textMode | literal | date,file,program,literal,url | Controls the behavior of xscreensaver-text. | no | | |
| textLiteral | I love eLux | string | Print the given string. | no | | |
| ShouldShowUserName | false | boolean | Specifies whether the logged-in user name is displayed on the screensaver lock screen or the testLiteral | | | 7.2603 |
| textFile | /setup/xscreensaver/textfile.txt | path | Print the contents of the given file. | no | | |
| (program executable path, unnamed) | (unset) | <executable> | Run the given program and print its output. | no | | |
| (slideshow directory, unnamed) | (unset) | path | if hack==slideshow this directory will be searched recursively for images. | no | | |
| (cycle period, unnamed) | (unset) | <HH:MM:SS> | if mode==random, after the screensaver has been running for this many minutes, the currently running graphics-hack sub-process will be killed (with SIGTERM), and a new one started. | no | | |
| nice | 10 | integer | The sub-processes created by xscreensaver will be "niced" to this level. see: man nice(1) | no | | |
| XSlockTimeout | 0:00:00 | <HH:MM:SS> | If locking is enabled, this controls the length of the "grace period" between when the screensaver activates, and when the screen becomes locked. | no | | |
| fade | true | boolean | If true, the current contents of the screen will fade to black instead of simply winking out. Default fadeSeconds=3 | no | | |

> Honesty flag: program-executable-path, slideshow-directory, and cycle-period rows had blank
> Parameter cells; excluded from generated schema.

## [xscreensaver_html5]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| Uri | <empty> | | Uri Screensaver should show (http(s):// or File://) | no | | |

## [xscreensaver_dialog]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| MessageEnabled | true | <true>,<false> | Enable/Disable 'leave message' button in ucscreensaver lock dialog | no | | |
| ShowSysCommandButtons | false | <true>,<false> | "Enable/Disable 'trigger system action' button" in ucscreensaver lock dialog to provide buttons for logoff, restart and shutdown | no | | |

## [PPTP]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| Activated | true | true,false | PPTP vpnclient | no | | |
| Server | (unset) | ip-addr | Server IP Address | no | | |
| User | (unset) | | | no | | |
| Password | (unset) | | | no | | |
| AllowedNetworks | (unset) | | Anzahl der Netze die getunnelt werden (number of networks tunneled) | no | | |
| AllowNet0 | (unset) | 1..n Netz | Netz/Maske 192.168.16.0/255.255.255.0 (one row per tunneled network, e.g. AllowNet0, AllowNet1, ...) | no | | |

> Honesty flag: AllowedNetworks and AllowNet0 were resolved by cross-checking the older
> `eLux terminal.ini.pdf` reference — confident reads, not inferred.

## [ScoutHandshake]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| MaxRetries (MaxRetry deprecated) | 0 | | stop trying after reaching this value, if set to 0 (default), the Scout handshake is inactive | yes | | |
| RetryTimer | 5 | | seconds before next retry, after each retry this time is doubled | yes | | |
| WaitUser | 60 | | seconds to wait for the user to close/logoff all applications | yes | | |
| CanCancel | false | true,false | whether the user can cancel the reboot process or not | yes | | |
| PermanentRetriesAfterDays | 0 | | start handshake after this number of days has passed | yes | | |

## [nfs_options]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| protocol | udp | "tcp","udp" | nfs protocol | no | | |
| rsize | 8192 | integer | see: man 5 nfs | no | | |
| wsize | 8192 | integer | see: man 5 nfs | no | | |

## [pkcs11]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| installed | (unset) | blank-separated list | Die Namen der installierten PKCS#11 Pakete. Bisher gibt es: "HiPath" "SafeSign" und "eToken" (names of installed PKCS#11 packages; so far: HiPath, SafeSign, eToken) | no | | |
| active | (unset) | string | Einer aus der Liste installed. Er ist der default für [security][PamPkcs11Module] (one from the `installed` list; default for [Security]PamPkcs11Module) | no | | |
| logging | false | true,false | Aktiviert logging für die aktive pkcs11 bibliothek (WARNUNG: kann in kurzer Zeit eine große Datenmenge produzieren) (Activates logging for the active pkcs11 library; WARNING: can produce a large amount of data quickly) | no | | |

## [pkcs11 <string>]

> Each installed PKCS#11 package brings such a section and adds the `<string>` to the
> `[pkcs11]installed` list.

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| Module | (unset) | path | Pfad zur PKCS#11 Bibliothek (path to the PKCS#11 library) | no | | |
| LongName | (unset) | string | vollständiger Name der Bibliothek, siehe pkcs11-tool -I (full name of the library, see pkcs11-tool -I) | no | | |
| Version | (unset) | string | Version der Bibliothek, siehe pkcs11-tool -I (library version, see pkcs11-tool -I) | no | | |

> Honesty flag: LongName and Version were resolved by cross-checking the older
> `eLux terminal.ini.pdf` reference — confident reads, not inferred.

## [SmartCard]

> Cross-checked: the older `eLux terminal.ini.pdf` confirms `[SmartCard]` is its own top-level
> section (not folded into `[pkcs11 <string>]`), containing at minimum `OnScRemoval` (default
> `none`, range `none,logoff,lock`, Datamodel Object `Pkcs11.SmartcardRemoveAction`) as of that
> doc's revision. The newer primary doc additionally documents `OnScInsert`, `ScInsertScript`,
> `ScRemoveScript`, `PauseActionOnDifferentCardInserted`, `PauseActionTimeoutSeconds`,
> `ScTriggerCardScope`, `EnableProcessBlocklist`, and `AvoidRawProtocol` (all since 7.2601/7.2605),
> which did not yet exist in the older doc's revision — newer doc wins per source-priority rule.

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| OnScRemoval | none | none,lock,logoff,runscript | Action if smart card is removed | yes | Pkcs11.SmartcardRemoveAction | 7.2601 |
| OnScInsert | none | none,runscript | Defines the action performed when a SmartCard is inserted. | yes | | 7.2601 |
| ScInsertScript | none | full file path | Specifies the full path to the script executed on SmartCard insertion. | yes | | 7.2601 |
| ScRemoveScript | none | full file path | Specifies the full path to the script executed on SmartCard removal. | yes | | 7.2601 |
| PauseActionOnDifferentCardInserted | switchuser | switchuser,Ignore | Defines how the system reacts if a different SmartCard is inserted while a session is paused. | yes | | 7.2601 |
| PauseActionTimeoutSeconds | 30 | 5-300 | A timeout in seconds before the standard SmartCard removal action is applied when a session is paused. | yes | | 7.2601 |
| ScTriggerCardScope | 0 | 0,1 | ScTriggerCardScope=0 (Default): Every card can trigger insert, remove and pause action. ScTriggerCardScope=1: Only first card triggers insert, remove and pause action. | yes | | 7.2605 |
| EnableProcessBlocklist | true | true,false | To improve browser performance, prevent the listed processes (for example certutil, certificate management in the NSS database, or on tokens) from accessing PKCS#11 functions (such as C_GetFunctionList). | no | | 7.2601 |
| AvoidRawProtocol | false | true,false | Choose Block or RAW mode when reading cards. | | | |

## [Statistics]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| Server | eLuxManager aus [Network] | string | Hostname (oder IP) des Statistik Servers (hostname or IP of the statistics server) | no | | |
| Port | 22124 | integer | Port des Statistik Servers (port of the statistics server) | no | | |
| SendKeepAlive | false | true,false | Ein/Ausschalter des KeepAlive (KeepAlive on/off switch) | no | | |
| KeepAliveInterval | 600 | integer | Sendeintervall in Sekunden (60-153600) (send interval in seconds) | no | | |
| RespectLimits | true | true,false | Prüfung der Intervallgrenzen (check of interval bounds) | no | | |
| KeepAliveOption | 0 | integer | Bit-weise 1=aktueller Benutzer und Domäne werden mitgesendet, 2=Client Hostname und IP werden mitgesendet (bitwise: 1=current user+domain sent along, 2=client hostname+IP sent along) | no | | |
| Supervise | (unset) | usb,pci | Aktivierung der Geräteüberwachung bestimmter Gerätetypen (Komma separiert) für Asset (Dashboard) (Activation of device monitoring for certain device types, comma separated, for Asset Dashboard) | no | | |
| KeepAliveLegacy | false | true,false | Activates legacy keep alive protocol (UDP) | no | | |

> Honesty flag: SendKeepAlive, KeepAliveInterval, RespectLimits, and KeepAliveOption were resolved
> by cross-checking the older `eLux terminal.ini.pdf` reference — confident reads, not inferred.

## [ICALayout]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| DomainFieldStatus | 0 | 0=Enabled,1=Disabled,2=Invisible,3=Read-Only | Disables/hides the domain field in the ICA logon dialog | no | | |
| ServerFieldStatus | 0 | 0=Enabled,1=Disabled,2=Invisible,3=Read-Only | Disables/hides the server field in the ICA logon dialog | no | | |

## [PNLLayout]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| DomainFieldStatus | 0 | 0=Enabled,1=Disabled,2=Invisible,3=Read-Only | Disables/hides the domain field in the PN logon dialog | no | | |
| ServerFieldStatus | 0 | 0=Enabled,1=Disabled,2=Invisible,3=Read-Only | Disables/hides the server field in the PN logon dialog | no | | |

## [DynamicProxy]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| UseConsumer | true | {true,false} | Enable/Disable consumer | yes | | |
| UseProvider | true | {true,false} | Enable/Disable provider | yes | | |
| TerminatedMonitoringTimeout | 1800 | int in seconds | Looking for all consumer, if there are no more updater (search failed): update myself (shutdown proxy service) and shutdown/reboot in case this provider was used by any consumer | no | | |
| ProxyMonitoringTimeout | 120 | int in seconds | Avoid proxy consumers without update partition from having no proxy, after reboot while updating | no | | |

## [UpdateWatcher]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| SleepTimer | 30 | int in seconds | If continuous file I/O happens, sleeps 30 seconds before check threshold again | no | | |
| FreespaceThresholdPercent | 10 | int in percent | Threshold in percentage of partition | no | | |
| FreespaceThresholdMb | 100 | int in MB | Threshold in Megabyte | no | | |
| RemoveOldFiles | true | true,false | Defines whether UpdateWatcher is on/off | no | | |

> Honesty flag: SleepTimer and FreespaceThresholdPercent were resolved by cross-checking the older
> `eLux terminal.ini.pdf` reference — confident reads, not inferred.

## [ctxh264]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| EnableLogging | false | false,true | Activates logging of the ica ctxh264 plugin | no | | |
| LogPath | /tmp/ctxh264.log | string | Path where the log file is written | no | | |
| HardwareAccelerationType | VAAPI | NONE,VAAPI | The used hardware acceleration for frame decoding, NONE is software decoding | no | | |
| EnableHardwareInterop | true | false,true | If true the HardwareAccelerationType is used for yuv420 to rgb conversion, if false it is done manually with shaders | no | | |
| ForceRenderMethod | NONE,OPENGL,XSHM | NONE | Normally the best supported render method is used. The rating is OPENGL > XSHM > X11. If ForceRenderMethod is not NONE this render method is used when it is supported | no | | |
| DrawLogo | false | false,true | if true the unicon logo is shown as an overlay | no | | |
| GlVariant | GLX | GLX,EGL | Set the OpenGL variant to use | no | | |

## [FileFetch]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| URL | (unset) | string | URL of file webserver including hostname and path. Trailing slash can be omitted. | no | | |
| FilePattern | (unset) | string (regex) | Regular expression containing pattern for files to fetch. Optional. Example: `\d*\.(gif|jpg|png)` | no | | |
| LocalDirectory | /setup/xscreensaver | string | Local folder in which files are stored. Optional. | no | | |

## [PowerManagement]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| Profile | 0 | 0,1,2 | The currently used power management profile. 0=Auto: Automatically switch between eco and performance based on the ac power plug. Plugged in: Performance, Unplugged: Eco. 1=Eco: Force eco profile. 2=Performance: Force performance profile | no | | |
| LowBatteryThreshold | 10 | 1-100 | Threshold in percent for low battery warning notification | no | | |
| LogoffBeforeSuspend | false | false,true | Proceed logoff before suspend when sleep mode is triggered | | | |
| ConfirmationTimer | 10 | 10-60 | Shutdown, Sleep timer before automatic confirmation (timer in seconds) | | | |
| ConfirmationTimerEnabled | true | true,false | Activates/deactivates shutdown timer | | | |

> Honesty flag: Profile was resolved by cross-checking the older `eLux terminal.ini.pdf` reference
> — confident read, not inferred.

## [PowerManagementEco]

> Settings for the powermanagement eco profile

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| BrightnessLevel | 50 | int | Brightness level in percent | no | | |
| LidCloseAction | 3 | 0-3 | 0=None, 1=DisplayOff (lock if screensaver is configured and AD login is active), 2=ShutDown, 3=Suspend | no | | |
| PowerButtonAction | 2 | 0-4 | 0=None, 1=DisplayOff (lock if screensaver is configured and AD login is active), 2=ShutDown, 3=Suspend, 4=Ask | no | | |
| DisplayOffTimerEnabled | true | true,false | Enable display off timer | no | | |
| DisplayOffTimer | 60 | int | Turn display off after n-seconds of idle time | no | | |
| DisplayLockTimerEnabled | true | true,false | Enable display lock timer | no | | |
| DisplayLockTimer | 60 | int | Lock display off after n-seconds of idle time | no | | |
| IdleTimerEnabled | true | true,false | Enable idle timer | no | | |
| IdleTimer | 600 | int | Execute IdleAction after n-seconds of idle time | no | | |
| IdleAction | 3 | 2-3 | 2=ShutDown, 3=Suspend | no | | |

## [PowerManagementEcoNonWorking]

> Settings for the powermanagement eco profile outside working hours. Same parameter set and
> semantics as `[PowerManagementEco]`.

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| BrightnessLevel | 50 | int | Brightness level in percent | no | | |
| LidCloseAction | 3 | 0-3 | 0=None, 1=DisplayOff (lock if screensaver is configured and AD login is active), 2=ShutDown, 3=Suspend | no | | |
| PowerButtonAction | 2 | 0-4 | 0=None, 1=DisplayOff (lock if screensaver is configured and AD login is active), 2=ShutDown, 3=Suspend, 4=Ask | no | | |
| DisplayOffTimerEnabled | true | true,false | Enable display off timer | no | | |
| DisplayOffTimer | 60 | int | Turn display off after n-seconds of idle time | no | | |
| DisplayLockTimerEnabled | true | true,false | Enable display lock timer | no | | |
| DisplayLockTimer | 60 | int | Lock display off after n-seconds of idle time | no | | |
| IdleTimerEnabled | true | true,false | Enable idle timer | no | | |
| IdleTimer | 600 | int | Execute IdleAction after n-seconds of idle time | no | | |
| IdleAction | 3 | 2-3 | 2=ShutDown, 3=Suspend | no | | |

> Honesty flag: BrightnessLevel=50 and LidCloseAction=3 were confirmed by cross-checking the older
> `eLux terminal.ini.pdf` reference, which renders this table without the page-break truncation
> present in the primary doc. No longer an inference — confident read.

## [PowerManagementPerformance]

> Settings for the powermanagement performance profile

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| BrightnessLevel | 100 | int | Brightness level in percent | no | | |
| LidCloseAction | 1 | 0-3 | 0=None, 1=DisplayOff (lock if screensaver is configured and AD login is active), 2=ShutDown, 3=Suspend | no | | |
| PowerButtonAction | 2 | 0-4 | 0=None, 1=DisplayOff (lock if screensaver is configured and AD login is active), 2=ShutDown, 3=Suspend, 4=Ask | no | | |
| DisplayOffTimerEnabled | See [Screen]→ScreenSaverOff negated | true,false | Enable display off timer, value will be copied over from old value if not explicitly specified | no | | |
| DisplayOffTimer | See [Screen]→StandbyTime | int | Turn display off after n-seconds of idle time, value will be copied over from old value if not explicitly specified | no | | |
| DisplayLockTimerEnabled | See [Layout]→UseScreenSaver | true,false | Enable display lock timer, value will be copied over from old value if not explicitly specified | no | | |
| DisplayLockTimer | See [Layout]→XAutoLockDelay | int | Lock display off after n-seconds of idle time, value will be copied over from old value if not explicitly specified | no | | |
| IdleTimerEnabled | true | true,false | Enable idle timer | no | | |
| IdleTimer | 1200 | int | Execute IdleAction after n-seconds of idle time | no | | |
| IdleAction | 3 | 2-3 | 2=ShutDown, 3=Suspend | no | | |

## [PowerManagementPerformanceNonWorking]

> Settings for the powermanagement performance profile outside working hours.

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| BrightnessLevel | 100 | int | Brightness level in percent | no | | |
| LidCloseAction | 1 | 0-3 | 0=None, 1=DisplayOff (lock if screensaver is configured and AD login is active), 2=ShutDown, 3=Suspend | no | | |
| PowerButtonAction | 2 | 0-4 | 0=None, 1=DisplayOff (lock if screensaver is configured and AD login is active), 2=ShutDown, 3=Suspend, 4=Ask | no | | |
| DisplayOffTimerEnabled | See [Screen]→ScreenSaverOff negated | true,false | Enable display off timer, value will be copied over from old value if not explicitly specified | no | | |
| DisplayOffTimer | See [Screen]→StandbyTime | int | Turn display off after n-seconds of idle time, value will be copied over from old value if not explicitly specified | no | | |
| DisplayLockTimerEnabled | See [Layout]→UseScreenSaver | true,false | Enable display lock timer, value will be copied over from old value if not explicitly specified | no | | |
| DisplayLockTimer | See [Layout]→XAutoLockDelay | int | Lock display off after n-seconds of idle time, value will be copied over from old value if not explicitly specified | no | | |
| IdleTimerEnabled | true | true,false | Enable idle timer | no | | |
| IdleTimer | 1200 | int | Execute IdleAction after n-seconds of idle time | no | | |
| IdleAction | 3 | 2-3 | 2=ShutDown, 3=Suspend | no | | |

## [Bluetooth]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| Enabled | false | true,false | Enable/disable bluetooth | yes | | |
| AllowedServiceUuids | empty (all services allowed) | | Specifies the bluetooth service UUIDS which are allowed and can be connected to. For example one can allow HID device but not headset. See also bluetooth plugin wiki page. | | | 7.2411 |

> Honesty flag: Enabled and AllowedServiceUuids were resolved by cross-checking the older
> `eLux terminal.ini.pdf` reference — confident reads, not inferred. Note the default for `Enabled`
> differs slightly between docs (older doc shows `false`, newer doc's row was itself unnamed so no
> conflicting default was directly observed there); `false` is used as the cross-checked value.

## [Hotkeys]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| Logoff | (unset) | | Specifies the hotkey combination for logoff | ? | | |
| Lock | <Alt><Ctrl>End | | Specifies the hotkey combination for lock | ? | | |
| CloneDisplays | (unset) | | Specifies the hotkey combination for monitor cloning, f.e. <Hyper>p. Alternative notations for the Win modifier key: <Mod4>p, <Super>p | | | |
| Fadeout | (unset) | Special keys: e.g. <Ctrl>,<Alt>,<Super>... | Given key combination + 1 is fading out primary display. Given key combination + 2 is fading out all non primary displays. Example: <Ctrl><Alt>. When user presses <Ctrl><Alt>1 primary monitor is hidden. When user presses <Ctrl><Alt>2 all non primary monitors are hidden | | | |
| PauseAction | <Shift>,<Ctrl>,<Alt><Shift> | | Controls which keyboard key activates the Pause workflow during SmartCard removal. | yes | | 7.2601 |

## [Xorg]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| IgnoreUsbInput | (unset) | VendorID_1:ProdID_1,VendorID_2:ProdID_2 | List of USB devices which should not be registered as input devices. Example: 0b0e:034c,047f:c01e. Important: Only use lowercase letters for hexadecimal values! You can replace individual characters by the wildcard character `?`. Example: 0b0e:???? filters all products of a specific vendor. | | | |

## [Evidian]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| Autologin | (unset) | | Configured by scout, but there is no implementation on elux | | | |
| AuthServer | (unset) | | The evidian server to be used, e.g. https://win-evidian-01.presales.unicon-ka.de:9765/soap | | | |
| AllowScUserAuth | false | true,false | Users may log on with username and password | | | |
| UseSmartcard | false | true,false | Enables authentication via smart card | | | |
| Secret | (unset) | | Encrypted secret from the registry entry of the Enterprise Access Management server. HKEY_LOCAL_MACHINE\SOFTWARE\Enatel\WiseGuard\Framework\Authentication from the key ExternalRoamingSessionSecret. Required for smartcard authentication | | | |
| AuthDisplayNames | (unset) | | The domain prefilled in evidian dialog | | | |
| ScRemovalAction | lockscreen | lockscreen,logoffuser | Smartcard Removal Action. 0=lockscreen, 1=logoffuser | | | 6.2302.3000 |

## [OpenId]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| DiscoveryUrl | (unset) | a URL | URL to the well-known OpenID configuration Endpoint | | OpenIdConfiguration | 7.2511.0 |
| RedirectUrl | (unset) | a URL | OpenID redirect URL configured with OpenID provider. recommended choice is https://localhost/login/ | | OpenIdConfiguration | 7.2411.0 |
| ClientId | (unset) | | client ID obtained from the OpenID provider | | OpenIdConfiguration | 7.2411.0 |
| ClientSecret | (unset) | | client secret obtained from the OpenID provider | | OpenIdConfiguration | 7.2507.0 |

> Honesty flag: the `ClientId`/`ClientSecret` parameter-name cells were visually indistinct in the
> source PDF render (overlapping a UI artifact), but the Description column unambiguously reads
> "client ID obtained from the OpenID provider" / "client secret obtained from the OpenID
> provider" against Datamodel Object `OpenIdConfiguration`, which standard OIDC terminology and
> the spec document's own reference to eLux `[OpenId]` `ClientId`/`ClientSecret` corroborate.
> Treated as a confident read, not flagged `inferred: true`.

## [Imprivata]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| BootstrapUrl | (unset) | a URL | Initial boot strap URL | | Imprivata | 7.2505.0 |
| AuthenticationTimeoutSeconds | 60.0 | | Timeout (seconds) until authentication process has to be completed | | Imprivata.AuthenticationTimeoutSeconds | |
| FailoverSiteTimeoutSeconds | 300.0 | | | | Imprivata.FailoverTimeoutSeconds | |
| WarnTimeoutSeconds | 5.0 | 0s-3600s (float) | Warn when a request takes longer than this time. 0 to disable warnings. | | Imprivata.WarnTimeoutSeconds | 7.2601.0 |
| ErrorTimeoutSeconds | 60.0 | 0s-3600s (float) | Abort request when it takes longer than this time. 0 to disable errors. | | Imprivata.ErrorTimeoutSeconds | 7.2601.0 |
| OfflineTimeoutSeconds | 300.0 | 0s-3600s (float) | Find alternative sites when the offline timer is reached. 0 to disable timer. | | Imprivata.OfflineTimeoutSeconds | 7.2601.0 |

## [SAML]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| SsoUrl | (unset) | a URL | URL used for single sign on | | SamlConfiguration | 7.2511.0 |
| Issuer | (unset) | | The issuer ID | | SamlConfiguration | 7.2511.0 |
| Audience | (unset) | | The audience restriction | | SamlConfiguration | 7.2511.0 |
| CertificatePath | (unset) | | The path to where the IdP certificate is stored on eLux | | SamlConfiguration | 7.2511.0 |

## [VirtualKeyboard]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| Theme | elux-dark | elux-dark,elux-light | the theme for onboard keybord | | | 7.2603.0 |
| Layout | Compact-Elux | Compact-Elux,Full Keyboard-Elux | the layout for onboard keybord | | | 7.2603.0 |

## [Swap]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| SwapEnabled | true | true,false | Enable or disable swap file creation by the low_memory_workaround boot script (custom_swapon_lowmem FPM). When false, no swap is created regardless of system RAM. | yes | | 7.2605 |
| SwapSizeMB | 4096 | >=1 (MB) | Size of the swap file in megabytes. If an existing swap file at /custom/swap has a different size, it will be recreated with this size on next boot. | yes | | 7.2605 |
| (RAM threshold for swap creation, unnamed) | (unset) | >=1 (MB) | RAM threshold in megabytes. Swap is only created when the device's total RAM is below this value (default 4096 MB = 4 GB). | yes | | 7.2605 |

> Honesty flag: the "RAM threshold for swap creation" row had a blank Parameter cell; excluded
> from generated schema. Based on context (sibling key `SwapSizeMB`) this is plausibly named
> `SwapRamThresholdMb` or similar, but not transcribed as a confident read.

## [MemoryOptimisation]

| Parameter | Default Value | Value Range | Description | Publish? | Datamodel Object | ...since version? |
|---|---|---|---|---|---|---|
| Enabled | true | true,false | Enable or disable memory optimisation for on-demand windows (Device Configuration, Quick Config, Quick System Access). When enabled, on-demand windows are destroyed after the cleanup delay to reclaim memory. | ? (not in scout UI) | Desktop | 7.2605 |
| MemorySizeThresholdMb | 4096 | 0-∞ (int) | RAM threshold in MB. Memory optimisation is active only on devices with total RAM ≤ this value. Set to 0 to apply to all devices regardless of RAM. | | Desktop | 7.2605 |
| CleanupDelayMs | 5000 | 0-∞ (int) | Delay in milliseconds after an on-demand window is hidden before it is destroyed to free memory. | | Desktop | 7.2605 |
