# eLux kioskmode.ini — Reference Transcription

Source: `eLux kioskmode.ini.pdf` (Unicon documentation, 3 pages, read in full).

Config file: `/setup/kioskmode.ini`. Contents depend on the configured appliance mode.

This is a plain-markdown transcription of the parameter tables in the source PDF. It is
the input consumed by `scripts/generate-elux-schema.ts` to produce `schema/elux-config.json`.
Columns: Parameter | Default Value | Value Range | Description | Publish?

Table sections found in the source, in document order:

- `[Parameters]` (UCSelfService)
- `[Theme]`
- `[Store<1-N>]`
- `[Environment_Store<1-N>]`
- `[PassThroughCredentials]`
- `[Browser<1-N>]`

No `sinceVersion` column exists in this document except where called out inline (e.g. "Since RP 6.8",
"Obsolete since RP6.8"). Those are captured in the Notes column below.

---

## [Parameters] (UCSelfService)

| Parameter | Default Value | Value Range | Description | Publish? |
|---|---|---|---|---|
| ReconnectOnLogon | false | true,false | Citrix SelfService setting. Determines whether the self-service UI tries to reconnect to all sessions, for a given store, immediately after logon to that store. | yes |
| ReconnectOnLaunchOrRefresh | false | true,false | Citrix SelfService setting. Determines whether the self-service UI tries to reconnect to all sessions when an application is launched or the store is refreshed. | yes |
| SharedUserMode | false | true,false | Citrix SelfService setting. Indicates whether Shared User Mode is enabled. This allows the self-service UI to use one system user account for multiple users by removing user data from the device when users log off or close the UI. Recommended: Do not use this setting in combination with PreLogin=true | yes |
| SelfSelection | false | true,false | Citrix SelfService setting. Used to disable the search box and the self-selection panel. Note that this is used only by the legacy green UI. The self-selection panel appears on the left of the self-service UI when you click + (the plus sign). Disabling these UI elements prevents users from subscribing to extra applications. | yes |
| LogoffMode | 0 | 0,1,2,3 | 0 = None; 1 = Logoff timer is started with logon; 2 = Logoff timer is started when the latest Citrix app is closed; 3 = Logoff timer is started when first Citrix app/desktop is opened | yes |
| LogoffDelay | 0 | seconds | Defines delay in seconds until logoff takes place after logoff timer has started | yes |
| LogoffInfoTimeout | 0 | seconds | Shows user info for n seconds if logoff has started | yes |
| ShowLastUser | true | true,false | Fills user field with last logged in user name | yes |
| PreLogin | false | true,false | Whether to show the pre-login dialog. Recommended: Do not use this setting in combination with SharedUserMode=true | yes |
| PreLoginTitle | (unset) | string | Pre-login dialog title | yes |
| PassThroughMode | 0 | 0,1,2 | 0 = none; 1 = AD; 2 = UserPassword | yes |
| Domain<1-N> | (unset) | string | Each entry contains one domain in the format `<friendlyName>,<domain>,<domain helper url>`. If a domain helper url is given, the pre-login dialog shows an additional button which calls the internal browser with this url. The additional button shows the given text "I forgot my password" which can be changed by the setting DomainHelperName. | yes |
| DomainHelperName | "I forgot my password" | string | Alternate button text for domain helper button. | unset |
| DomainHelperTimeout | 0 | seconds | The domain helper browser is closed after given timeout (in seconds) | unset |
| DomainHelperOptions | (unset) | string | Options to be added to the domain helpers command-line | unset |
| KeepAbove | true | true,false | Keep prelogin dialog window above others | yes |
| KeepBelow | false | true,false | Keep prelogin dialog window below others | yes |
| SessionWindowedMode | false | true,false | Display desktops windowed or fullscreen | yes |

## [Theme]

| Parameter | Default Value | Value Range | Description | Publish? |
|---|---|---|---|---|
| ThemeName | ucselfservice | string | The name of the GTK theme to be used within the uidialoglib. A GTK2 resource file can be placed to /setup/ica/<theme name>.gtkrc | no |
| Decorated | false | false,true | If true the uidialoglib windows have a window decoration | yes |
| ColorHover | #e6f1f7 | RGB color string | Citrix list selection widgets: background color for list elements on mouse hover | yes |
| ColorUnselected | #ffffff | RGB color string | Citrix list selection widgets: background color for unselected list elements | yes |
| ColorSelected | #cce3f0 | RGB color string | Citrix list selection widgets: background color for selected list elements | yes |

## [Store<1-N>]

| Parameter | Default Value | Value Range | Description | Publish? |
|---|---|---|---|---|
| Url | (unset) | string | URL of the citrix store | yes |
| FriendlyName | (unset) | string | Name to be displayed to the user | yes |
| Default | false | false,true | Is this the default store | yes |
| AutostartResources | (unset) | string | List (separated by semicolon) of Citrix apps/desktops to be launched after logon. Currently only available with PreLogin=true | yes |
| Favorite | false | true,false | Since RP 6.8: If set to true the item will be marked as favorite in the portal selector, favorites are listed first | unset |

## [Environment_Store<1-N>]

> Note: If a store is defined in this section the systembar will show an icon to select the store and will group them by Environment.

| Parameter | Default Value | Value Range | Description | Publish? |
|---|---|---|---|---|
| Url | (unset) | string | URL of the citrix store | yes |
| FriendlyName | (unset) | string | Name to be displayed to the user | yes |
| Default | false | false,true | Is this the default store | yes |
| Environment | (unset) | string | The stores will be grouped by the environment. Obsolete since RP6.8: Grouping was replaced by favorites | yes |
| AutostartResources | (unset) | string | List (separated by semicolon) of Citrix apps/desktops to be launched after logon. Currently only available with PreLogin=true | yes |

## [PassThroughCredentials]

> Note: Only used if PassThroughMode is UserPassword. If more than one store is given, be sure that credentials will work with default store.

| Parameter | Default Value | Value Range | Description | Publish? |
|---|---|---|---|---|
| Username | (unset) | string | Username for pass-through | yes |
| Domain | (unset) | string | Domain for pass-through | yes |
| Password | (unset) | string | ICA encrypted password for pass-through | yes |

## [Browser<1-N>]

| Parameter | Default Value | Value Range | Description | Publish? |
|---|---|---|---|---|
| Url | (unset) | string | The URL which will be displayed on startup | yes |
| Homepage | (unset) | string | The URL which should be loaded when pressing the home button | yes |
| SaveFirstLink | false | true,false | If true the first url loaded when coming from the homepage will be saved as Url | yes |
| Navbar | true | true,false | Toggles browser navigation bar | yes |
| NavbarPrint | true | true,false | Toggles print button in browser navigation bar | yes |
| NavbarNavigate | true | true,false | (no description given in source) | yes |
| NavbarForward | true | true,false | Toggles forward button in browser navigation bar | yes |
| NavbarBackward | true | true,false | Toggles backward button in browser navigation bar | yes |
| NavbarHome | true | true,false | Toggles home button in browser navigation bar | yes |
| NavbarUrl | true | true,false | Toggles url bar in browser navigation bar | yes |
| NavbarRefresh | true | true,false | Toggles refresh button in browser navigation bar | yes |
| Favorite | false | true,false | Since RP 6.8: If set to true the item will be marked as favorite in the portal selector | unset |
| Default | false | true,false | Since RP 6.8: This Url will be loaded after boot. Only one item can be default and this will change automatically if the user selected a different item. And the new item will get the default one | unset |
| FriendlyName | (unset) | string | Since RP 6.8: Name to be displayed to the user | unset |

---

## Transcription notes / honesty flags

- `NavbarNavigate` has an empty Description cell in the source table — left blank, noted explicitly above.
- `Favorite`/`Default`/`FriendlyName` rows in `[Store<1-N>]` and `[Browser<1-N>]` have an empty "Publish?" cell in the source PDF table (the column simply has no value rendered for those rows) — recorded as `unset` rather than guessed as yes/no.
- "Since RP 6.8" / "Obsolete since RP6.8" annotations are preserved verbatim in the Description/notes; they are not eLux terminal.ini `sinceVersion` style version strings (different versioning scheme — Citrix Receiver/Workspace app "RP" release), so the generator maps them to `notes`, not `sinceVersion`.
