/**
 * GAS Backend for Personal Cloud Desktop
 * v2: multi-desktop switching, lazy folder tree, per-user app links
 */

const DESKTOPS_ROOT_NAME = "雲端桌面群組"; // container folder holding 桌面1、桌面2...

// ---------- Desktop folder management ----------

function getOrCreateDesktopsRoot() {
  const folders = DriveApp.getFoldersByName(DESKTOPS_ROOT_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(DESKTOPS_ROOT_NAME);
}

function getCurrentDesktopFolder() {
  const props = PropertiesService.getUserProperties();
  let folderId = props.getProperty('CURRENT_DESKTOP_ID');
  if (folderId) {
    try {
      return DriveApp.getFolderById(folderId); // validate it still exists / is still accessible
    } catch (e) {
      // fall through and create a default below
    }
  }
  const root = getOrCreateDesktopsRoot();
  const folder = root.createFolder("桌面1");
  props.setProperty('CURRENT_DESKTOP_ID', folder.getId());
  seedDefaultAppLinks(folder);
  return folder;
}

function listAvailableDesktops() {
  const root = getOrCreateDesktopsRoot();
  const folders = root.getFolders();
  const currentId = PropertiesService.getUserProperties().getProperty('CURRENT_DESKTOP_ID');
  let list = [];
  while (folders.hasNext()) {
    const f = folders.next();
    list.push({ id: f.getId(), name: f.getName(), active: f.getId() === currentId, shared: false });
  }
  getExternalDesktops().forEach(d => {
    list.push({ id: d.id, name: '🔗 ' + d.name, active: d.id === currentId, shared: true });
  });
  return list;
}

// Desktops someone else shared with you via Drive's own folder-sharing —
// you don't own these, they just live in your switcher list. Nothing here
// touches Drive permissions; Drive's native sharing already gatekeeps access.
function getExternalDesktops() {
  const raw = PropertiesService.getUserProperties().getProperty('EXTERNAL_DESKTOPS');
  return raw ? JSON.parse(raw) : [];
}

function addSharedDesktop(folderIdOrUrl) {
  const id = extractFolderId(folderIdOrUrl);
  const folder = DriveApp.getFolderById(id); // throws if you don't have access — that's the permission gate
  const list = getExternalDesktops();
  if (!list.some(d => d.id === id)) {
    list.push({ id: id, name: folder.getName() });
    PropertiesService.getUserProperties().setProperty('EXTERNAL_DESKTOPS', JSON.stringify(list));
  }
  return { id: id, name: folder.getName() };
}

// Only removes it from YOUR list — never touches the actual folder or its
// sharing settings, so the owner and anyone else it's shared with are unaffected.
function removeSharedDesktop(folderId) {
  const list = getExternalDesktops().filter(d => d.id !== folderId);
  PropertiesService.getUserProperties().setProperty('EXTERNAL_DESKTOPS', JSON.stringify(list));
  return { status: "success" };
}

function renameDesktop(folderId, newName) {
  // A desktop someone shared with you only gets relabeled in YOUR OWN list —
  // renaming the real Drive folder would change it for the owner and everyone
  // else it's shared with too, and would fail outright if you're only a viewer.
  const externalList = getExternalDesktops();
  const idx = externalList.findIndex(d => d.id === folderId);
  if (idx !== -1) {
    externalList[idx].name = newName;
    PropertiesService.getUserProperties().setProperty('EXTERNAL_DESKTOPS', JSON.stringify(externalList));
    return { status: "success", name: newName };
  }
  // Otherwise it's genuinely your own desktop folder — rename it for real.
  DriveApp.getFolderById(folderId).setName(newName);
  return { status: "success", name: newName };
}

function extractFolderId(input) {
  const m = input.match(/folders\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : input.trim();
}

function createNewDesktop(name) {
  const root = getOrCreateDesktopsRoot();
  const folder = root.createFolder(name || "新桌面");
  seedDefaultAppLinks(folder);
  return { id: folder.getId(), name: folder.getName() };
}

function switchDesktop(folderId) {
  PropertiesService.getUserProperties().setProperty('CURRENT_DESKTOP_ID', folderId);
  return getDesktopItems();
}

// ---------- App links (personal service icons — Gmail, Calendar, etc.) ----------
// Stored per-user in UserProperties, keyed by desktop folder id — NOT written into
// the shared Drive folder. That's what lets co-workers sharing the same desktop
// each see their own Gmail/Calendar icon pointing at their own account, without
// the icons colliding or being visible to each other.

const DEFAULT_APP_LINKS = [
  { name: "Gmail", url: "https://mail.google.com/mail/u/0/#inbox", icon: "gmail", default: true },
  { name: "日曆", url: "https://calendar.google.com/calendar/u/0/r", icon: "calendar", default: true },
  { name: "雲端硬碟", url: "https://drive.google.com/drive/u/0/my-drive", icon: "drive", default: true },
  { name: "Keep", url: "https://keep.google.com/u/0/", icon: "keep", default: true }
];

function seedDefaultAppLinks(folder) {
  const props = PropertiesService.getUserProperties();
  const key = 'APP_LINKS_' + folder.getId();
  if (!props.getProperty(key)) {
    props.setProperty(key, JSON.stringify(DEFAULT_APP_LINKS));
  }
}

function getAppLinks(folderId) {
  const props = PropertiesService.getUserProperties();
  const key = 'APP_LINKS_' + folderId;
  const raw = props.getProperty(key);
  return raw ? JSON.parse(raw) : DEFAULT_APP_LINKS;
}

function saveAppLinks(folderId, links) {
  PropertiesService.getUserProperties().setProperty('APP_LINKS_' + folderId, JSON.stringify(links));
  return { status: "success" };
}

// ---------- Desktop items (drive shortcuts + personal app links) ----------

function getDesktopItems(browseFolderId) {
  const desktopFolder = getCurrentDesktopFolder();
  const targetFolder = browseFolderId ? DriveApp.getFolderById(browseFolderId) : desktopFolder;
  const userProperties = PropertiesService.getUserProperties().getProperties();

  let items = [];

  // Items with no saved position yet (never dragged) get placed into a grid
  // one slot at a time instead of all piling up on the same default point.
  let autoPlaceIndex = 0;
  const AUTO_PLACE_COLS = 6;
  function nextAutoPos() {
    const col = autoPlaceIndex % AUTO_PLACE_COLS;
    const row = Math.floor(autoPlaceIndex / AUTO_PLACE_COLS);
    autoPlaceIndex++;
    return { x: 20 + col * 100, y: 20 + row * 100 };
  }

  // Real subfolders physically inside the folder being viewed.
  const subfolders = targetFolder.getFolders();
  while (subfolders.hasNext()) {
    const folder = subfolders.next();
    const posKey = folder.getId();
    const meta = userProperties[posKey] ? JSON.parse(userProperties[posKey]) : {};
    const hasPos = meta.x != null && meta.y != null;
    const pos = hasPos ? { x: meta.x, y: meta.y } : nextAutoPos();
    items.push({
      type: "folder",
      id: folder.getId(),
      name: folder.getName(),
      real: true,
      iconOverride: meta.icon || null,
      sound: meta.sound || null,
      mobileOrder: meta.mobileOrder != null ? meta.mobileOrder : null,
      x: pos.x,
      y: pos.y
    });
  }

  const files = targetFolder.getFiles();
  while (files.hasNext()) {
    const file = files.next();
    const isShortcut = file.getMimeType() === MimeType.SHORTCUT;
    const targetId = isShortcut ? file.getTargetId() : file.getId();
    const targetMime = isShortcut ? file.getTargetMimeType() : file.getMimeType();
    const posKey = file.getId();
    const meta = userProperties[posKey] ? JSON.parse(userProperties[posKey]) : {};
    const hasPos = meta.x != null && meta.y != null;
    const pos = hasPos ? { x: meta.x, y: meta.y } : nextAutoPos();
    const x = pos.x;
    const y = pos.y;

    if (targetMime === MimeType.FOLDER) {
      // A shortcut whose target is itself a folder — clicking browses into
      // the real folder elsewhere in Drive, it doesn't open a document.
      items.push({
        type: "folder",
        id: file.getId(),
        targetId: targetId,
        name: file.getName(),
        real: false,
        iconOverride: meta.icon || null,
        sound: meta.sound || null,
        mobileOrder: meta.mobileOrder != null ? meta.mobileOrder : null,
        x: x, y: y
      });
      continue;
    }

    items.push({
      type: "drive",
      id: file.getId(),
      targetId: targetId,
      name: file.getName(),
      mimeType: targetMime,
      url: getSanitizedUrl(targetMime, targetId),
      isShortcut: isShortcut,
      iconOverride: meta.icon || null,
      sound: meta.sound || null,
      mobileOrder: meta.mobileOrder != null ? meta.mobileOrder : null,
      x: x, y: y
    });
  }

  // Personal service links now live in the sidebar dock, not the desktop
  // grid — always available regardless of which folder you've browsed into.
  const appLinks = getAppLinks(desktopFolder.getId());
  const appLinksList = appLinks.map((link, i) => {
    const posKey = 'APPLINK_' + desktopFolder.getId() + '_' + i;
    const meta = userProperties[posKey] ? JSON.parse(userProperties[posKey]) : {};
    return {
      type: "app",
      id: posKey,
      name: link.name,
      mimeType: "application/vnd.google-apps.applink",
      url: link.url,
      icon: link.icon,
      iconOverride: meta.icon || null,
      sound: meta.sound || null,
      mobilePage: meta.mobilePage != null ? meta.mobilePage : null,
      removable: !link.default
    };
  });

  return {
    folderId: desktopFolder.getId(),
    browseFolderId: targetFolder.getId(),
    browseFolderName: targetFolder.getName(),
    items: items,
    appLinks: appLinksList,
    background: getBackgroundUrl(desktopFolder.getId()),
    music: getMusicUrl(desktopFolder.getId()),
    volume: getMusicVolume(desktopFolder.getId()),
    sidebarState: getSidebarState(desktopFolder.getId()),
    mobilePageCount: getMobilePageCount(desktopFolder.getId()),
    clockMobilePos: getClockMobilePos(desktopFolder.getId()),
    wallpaperSettingsMobilePos: getWallpaperSettingsMobilePos(desktopFolder.getId()),
    musicSettingsMobilePos: getMusicSettingsMobilePos(desktopFolder.getId()),
    tabTitle: getCustomTitle(),
    clockColor: getClockColor(desktopFolder.getId()),
    iconOnlyTopbar: getIconOnlyTopbar(),
    isSharedDesktop: getExternalDesktops().some(d => d.id === desktopFolder.getId())
  };
}

function createSubfolder(parentFolderId, name) {
  const parent = DriveApp.getFolderById(parentFolderId);
  const folder = parent.createFolder(name);
  return { id: folder.getId(), name: folder.getName() };
}

function renameFolder(folderId, newName) {
  DriveApp.getFolderById(folderId).setName(newName);
  return { status: "success" };
}

// Trashes an actual physical folder AND everything inside it — only ever
// called for real subfolders created on the desktop, never for a folder
// shortcut (which goes through removeShortcut and leaves the target alone).
function removeFolder(folderId) {
  DriveApp.getFolderById(folderId).setTrashed(true);
  PropertiesService.getUserProperties().deleteProperty(folderId);
  return { status: "success" };
}

function getBackgroundUrl(folderId) {
  return PropertiesService.getUserProperties().getProperty('BG_' + folderId) || '';
}

function saveBackgroundUrl(folderId, url) {
  PropertiesService.getUserProperties().setProperty('BG_' + folderId, url);
  return { status: "success" };
}

function getMusicUrl(folderId) {
  return PropertiesService.getUserProperties().getProperty('MUSIC_' + folderId) || '';
}

function saveMusicUrl(folderId, url) {
  PropertiesService.getUserProperties().setProperty('MUSIC_' + folderId, url);
  return { status: "success" };
}

function getMusicVolume(folderId) {
  const v = PropertiesService.getUserProperties().getProperty('VOL_' + folderId);
  return v !== null ? parseFloat(v) : 0.5;
}

// Sidebar is always present now — this just tracks how much of it is shown:
// 'peek' (docked to the edge, just a tab), 'icons' (icon-only rail),
// 'full' (icons + labels, comfortable for clicking).
function getSidebarState(folderId) {
  const v = PropertiesService.getUserProperties().getProperty('SIDEBAR_STATE_' + folderId);
  return v || 'icons';
}

function getClockColor(folderId) {
  return PropertiesService.getUserProperties().getProperty('CLOCK_COLOR_' + folderId) || '';
}

function saveClockColor(folderId, color) {
  PropertiesService.getUserProperties().setProperty('CLOCK_COLOR_' + folderId, color);
  return { status: "success" };
}

// Not scoped to a desktop folder — this is "what does my browser tab say"
// for the whole app, which stays the same no matter which desktop you're on.
function getCustomTitle() {
  return PropertiesService.getUserProperties().getProperty('TAB_TITLE') || '';
}

// Manual emergency fallback — if a future CSS regression ever makes topbar
// text unreadable again (like the white-on-white dropdown bug), this lets
// someone switch to icon-only pills themselves without needing a code fix.
function getIconOnlyTopbar() {
  return PropertiesService.getUserProperties().getProperty('ICON_ONLY_TOPBAR') === 'true';
}

function saveIconOnlyTopbar(enabled) {
  PropertiesService.getUserProperties().setProperty('ICON_ONLY_TOPBAR', String(!!enabled));
  return { status: "success" };
}

function saveCustomTitle(title) {
  PropertiesService.getUserProperties().setProperty('TAB_TITLE', title);
  return { status: "success" };
}

function saveSidebarState(folderId, state) {
  PropertiesService.getUserProperties().setProperty('SIDEBAR_STATE_' + folderId, state);
  return { status: "success" };
}

function saveMusicVolume(folderId, val) {
  PropertiesService.getUserProperties().setProperty('VOL_' + folderId, String(val));
  return { status: "success" };
}

// Google native docs have a per-service edit URL that never touches drive.google.com.
// Everything else (PDFs, images, uploaded Office files) has no such alternative and
// falls back to drive.google.com/file/d/.../view — if the firewall blocks that domain
// outright, this is the one category of file that won't open from the desktop.
function getSanitizedUrl(mimeType, fileId) {
  const map = {};
  map[MimeType.GOOGLE_DOCS] = 'https://docs.google.com/document/d/' + fileId + '/edit';
  map[MimeType.GOOGLE_SHEETS] = 'https://docs.google.com/spreadsheets/d/' + fileId + '/edit';
  map[MimeType.GOOGLE_SLIDES] = 'https://docs.google.com/presentation/d/' + fileId + '/edit';
  map[MimeType.GOOGLE_FORMS] = 'https://docs.google.com/forms/d/' + fileId + '/edit';
  // Colab notebooks aren't in the MimeType enum, so this is matched by the raw
  // string. Without this, a notebook shortcut would fall through to Drive's
  // static preview page instead of the actual runnable Colab interface.
  if (mimeType === 'application/vnd.google.colaboratory') {
    return 'https://colab.research.google.com/drive/' + fileId;
  }
  return map[mimeType] || ('https://drive.google.com/file/d/' + fileId + '/view');
}

// ---------- Icon position ----------

function getIconMeta(itemId) {
  const raw = PropertiesService.getUserProperties().getProperty(itemId);
  return raw ? JSON.parse(raw) : {};
}

function saveIconPosition(itemId, x, y) {
  const meta = getIconMeta(itemId);
  meta.x = x; meta.y = y;
  PropertiesService.getUserProperties().setProperty(itemId, JSON.stringify(meta));
  return { status: "success" };
}

// Called after a mobile drag-reorder — orderedIds is every icon's id in its
// new left-to-right, top-to-bottom order. Only the mobile layout reads this
// field, so it never touches the desktop x/y stored in the same blob.
function saveMobileOrder(orderedIds) {
  const props = PropertiesService.getUserProperties();
  orderedIds.forEach((id, index) => {
    const raw = props.getProperty(id);
    const meta = raw ? JSON.parse(raw) : {};
    meta.mobileOrder = index;
    props.setProperty(id, JSON.stringify(meta));
  });
  return { status: "success" };
}

// A custom icon image lives in the same per-item blob as position, so both
// survive independently of each other (saving one never wipes the other).
function saveIconImage(itemId, url) {
  const meta = getIconMeta(itemId);
  meta.icon = url;
  PropertiesService.getUserProperties().setProperty(itemId, JSON.stringify(meta));
  return { status: "success" };
}

// A per-item launch sound — same generic itemId-keyed meta blob as
// saveIconImage, just a different field, so it works identically for
// desktop icons and sidebar app links.
function saveIconSound(itemId, url) {
  const meta = getIconMeta(itemId);
  if (url) meta.sound = url; else delete meta.sound;
  PropertiesService.getUserProperties().setProperty(itemId, JSON.stringify(meta));
  return { status: "success" };
}

// Which page of the new-gen mobile full-screen grid this item is pinned to.
// Items with no explicit page fall back to auto-chunked placement on the
// client — this only matters once something has actually been dragged onto
// a specific (possibly sparse) page.
function saveMobilePage(itemId, pageIndex) {
  const meta = getIconMeta(itemId);
  if (pageIndex === null || pageIndex === undefined) delete meta.mobilePage;
  else meta.mobilePage = pageIndex;
  PropertiesService.getUserProperties().setProperty(itemId, JSON.stringify(meta));
  return { status: "success" };
}

// A floor on how many pages the mobile grid shows — lets the person add a
// blank page on purpose without needing to fill every earlier page first.
function getMobilePageCount(folderId) {
  const v = PropertiesService.getUserProperties().getProperty('MOBILE_PAGE_COUNT_' + folderId);
  return v ? parseInt(v, 10) : 1;
}

function saveMobilePageCount(folderId, count) {
  PropertiesService.getUserProperties().setProperty('MOBILE_PAGE_COUNT_' + folderId, String(count));
  return { status: "success" };
}

// The clock/radio widget's position when it's placed as a movable icon in
// the new-gen mobile grid — fully separate from app-link storage since it
// isn't an app link, just {page, order}.
function getClockMobilePos(folderId) {
  const raw = PropertiesService.getUserProperties().getProperty('CLOCK_MOBILE_POS_' + folderId);
  return raw ? JSON.parse(raw) : { page: 0, order: 0 };
}

function saveClockMobilePos(folderId, page, order) {
  PropertiesService.getUserProperties().setProperty('CLOCK_MOBILE_POS_' + folderId, JSON.stringify({ page: page, order: order }));
  return { status: "success" };
}

// Two more synthetic (non-app-link) tiles for the new-gen grid — split out
// of the clock's own tap menu so the clock stays focused on playback
// control (play/pause, pick track, pick wallpaper) while these two handle
// actually configuring what's available to pick from.
function getWallpaperSettingsMobilePos(folderId) {
  const raw = PropertiesService.getUserProperties().getProperty('WPSET_MOBILE_POS_' + folderId);
  return raw ? JSON.parse(raw) : { page: 0, order: 1 };
}

function saveWallpaperSettingsMobilePos(folderId, page, order) {
  PropertiesService.getUserProperties().setProperty('WPSET_MOBILE_POS_' + folderId, JSON.stringify({ page: page, order: order }));
  return { status: "success" };
}

function getMusicSettingsMobilePos(folderId) {
  const raw = PropertiesService.getUserProperties().getProperty('MUSET_MOBILE_POS_' + folderId);
  return raw ? JSON.parse(raw) : { page: 0, order: 2 };
}

function saveMusicSettingsMobilePos(folderId, page, order) {
  PropertiesService.getUserProperties().setProperty('MUSET_MOBILE_POS_' + folderId, JSON.stringify({ page: page, order: order }));
  return { status: "success" };
}


// Renaming a shortcut file only relabels the shortcut itself — the target file's
// own name in its actual folder is untouched.
function renameShortcut(itemId, newName) {
  const file = DriveApp.getFileById(itemId);
  file.setName(newName);
  return { status: "success", name: newName };
}

// Trashes the SHORTCUT file only. For drive-type items this never touches the
// original file — removing an icon from the desktop must never be able to
// delete the single source of truth.
function removeShortcut(itemId) {
  const file = DriveApp.getFileById(itemId);
  file.setTrashed(true);
  PropertiesService.getUserProperties().deleteProperty(itemId);
  return { status: "success" };
}

function renameAppLink(folderId, index, newName) {
  const links = getAppLinks(folderId);
  if (links[index]) links[index].name = newName;
  saveAppLinks(folderId, links);
  return links;
}

function removeAppLink(folderId, index) {
  const links = getAppLinks(folderId);
  if (links[index] && links[index].default) {
    throw new Error("這是預設服務，不能移除。");
  }
  links.splice(index, 1);
  saveAppLinks(folderId, links);
  // Note: removing a middle entry shifts later indices, so their saved icon
  // positions may reset to default — a known minor rough edge, not a bug to chase yet.
  return links;
}

// oldIndexOrder is every link's OLD index, listed in the NEW order the user
// dragged them into. Per-link customization (custom icon override) is keyed
// by index, so it has to move together with its link, not get left behind.
function reorderAppLinks(folderId, oldIndexOrder) {
  const links = getAppLinks(folderId);
  const props = PropertiesService.getUserProperties();
  const oldMeta = {};
  oldIndexOrder.forEach(oldIdx => {
    const raw = props.getProperty('APPLINK_' + folderId + '_' + oldIdx);
    if (raw) oldMeta[oldIdx] = raw;
  });
  const newLinks = oldIndexOrder.map(i => links[i]);
  saveAppLinks(folderId, newLinks);
  oldIndexOrder.forEach((oldIdx, newIdx) => {
    const newKey = 'APPLINK_' + folderId + '_' + newIdx;
    if (oldMeta[oldIdx] != null) props.setProperty(newKey, oldMeta[oldIdx]);
    else props.deleteProperty(newKey);
  });
  return newLinks;
}

function addAppLink(folderId, name, url, iconKeyword) {
  const links = getAppLinks(folderId);
  let icon = iconKeyword;
  if (!icon) {
    icon = 'google.com';
    try { icon = url.replace(/^https?:\/\//, '').split('/')[0]; } catch (e) {}
  }
  links.push({ name: name, url: url, icon: icon });
  saveAppLinks(folderId, links);
  return links;
}

// ---------- Folder tree — lazy load, one level at a time ----------

function getSubfolders(folderId) {
  const folder = folderId ? DriveApp.getFolderById(folderId) : DriveApp.getRootFolder();
  const subfolders = folder.getFolders();
  let list = [];
  while (subfolders.hasNext()) {
    const f = subfolders.next();
    list.push({ id: f.getId(), name: f.getName() });
  }
  return list;
}

// ---------- Drag & drop ingestion ----------

// Checks whether the target folder already has a file with this exact name —
// used before upload so the person can choose update-in-place vs. keep both.
function checkExistingFile(targetFolderId, filename) {
  const folder = DriveApp.getFolderById(targetFolderId);
  const files = folder.getFilesByName(filename);
  if (files.hasNext()) {
    return { exists: true, fileId: files.next().getId() };
  }
  return { exists: false };
}

// If updateFileId is provided, replaces that existing file's content in place
// (same file ID, adds a version) — any shortcut anywhere that already points
// to it automatically shows the new content, nothing needs to be re-pointed.
// Requires the "Drive API" advanced service to be enabled in this project
// (Apps Script editor → Services → + → Drive API); without it, this throws.
function uploadAndShortcut(base64Data, filename, mimeType, targetFolderId, updateFileId, addShortcut) {
  const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, filename);
  let file;
  if (updateFileId) {
    Drive.Files.update({}, updateFileId, blob);
    file = DriveApp.getFileById(updateFileId);
  } else {
    const targetFolder = DriveApp.getFolderById(targetFolderId);
    file = targetFolder.createFile(blob);
  }
  const desktopFolder = getCurrentDesktopFolder();
  // If the file was uploaded directly into the desktop folder, it's already
  // visible there — creating a shortcut pointing to itself would be redundant.
  if (targetFolderId === desktopFolder.getId()) {
    return { id: file.getId(), name: file.getName() };
  }
  // Otherwise a shortcut is only created if the person asked for one —
  // uploading into some other folder no longer silently drops a shortcut
  // onto the desktop by default.
  if (!addShortcut) {
    return { id: file.getId(), name: file.getName() };
  }
  const shortcut = desktopFolder.createShortcut(file.getId());
  return { id: shortcut.getId(), name: shortcut.getName() };
}

function createShortcutToDesktop(targetFileId, folderId) {
  const targetFolder = folderId ? DriveApp.getFolderById(folderId) : getCurrentDesktopFolder();
  const shortcut = targetFolder.createShortcut(targetFileId);
  return { id: shortcut.getId(), name: shortcut.getName() };
}

// True move — relocates the item itself (a shortcut, a real file, or a real
// folder) from wherever it currently lives to destFolderId. For a shortcut
// this only moves the shortcut object; the file it points to never moves.
function moveItemToFolder(itemId, destFolderId, isRealFolder) {
  const destFolder = DriveApp.getFolderById(destFolderId);
  if (isRealFolder) {
    const folder = DriveApp.getFolderById(itemId);
    destFolder.addFolder(folder);
    const parents = folder.getParents();
    while (parents.hasNext()) {
      const parent = parents.next();
      if (parent.getId() !== destFolderId) parent.removeFolder(folder);
    }
  } else {
    const file = DriveApp.getFileById(itemId);
    destFolder.addFile(file);
    const parents = file.getParents();
    while (parents.hasNext()) {
      const parent = parents.next();
      if (parent.getId() !== destFolderId) parent.removeFile(file);
    }
  }
  return { status: "success" };
}

// ---------- Search ----------

function listMediaFiles(folderId, typePrefix) {
  const folder = DriveApp.getFolderById(folderId);
  const files = folder.getFiles();
  let list = [];
  while (files.hasNext()) {
    const f = files.next();
    const mime = f.getMimeType();
    if (mime && mime.indexOf(typePrefix) === 0) {
      list.push({ id: f.getId(), name: f.getName(), mimeType: mime });
    }
  }
  return list;
}

function searchDriveFiles(keyword) {
  if (!keyword) return [];
  const safe = keyword.replace(/'/g, "\\'");
  const query = "title contains '" + safe + "' and trashed = false";
  const files = DriveApp.searchFiles(query);
  let results = [];
  let limit = 10;
  while (files.hasNext() && results.length < limit) {
    const file = files.next();
    results.push({ id: file.getId(), name: file.getName(), mimeType: file.getMimeType(), url: file.getUrl() });
  }
  return results;
}

// Used by the folder-picker modal's search box — lets you jump straight to
// a folder by name instead of clicking down through the tree level by level.
function searchFolders(keyword) {
  if (!keyword) return [];
  const safe = keyword.replace(/'/g, "\\'");
  const query = "title contains '" + safe + "' and trashed = false";
  const folders = DriveApp.searchFolders(query);
  let results = [];
  let limit = 15;
  while (folders.hasNext() && results.length < limit) {
    const f = folders.next();
    results.push({ id: f.getId(), name: f.getName() });
  }
  return results;
}

// ---------- Entry point ----------
// Initial data is embedded server-side into the HTML template so the first
// paint already has icons — no second google.script.run round trip on load.

function doGet() {
  const data = getDesktopItems();
  const desktops = listAvailableDesktops();
  const template = HtmlService.createTemplateFromFile('Index');
  template.initialData = JSON.stringify(data).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  template.desktopList = JSON.stringify(desktops).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return template.evaluate()
    .setTitle(data.tabTitle || '雲端桌面')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
