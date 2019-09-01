import {
    TreeDataProvider,
    TreeItem,
    TreeItemCollapsibleState,
    Command,
    EventEmitter,
    Event,
    Disposable,
    TreeView,
    commands,
    window
} from "vscode";
import * as path from "path";
import {
    PlaylistItem,
    PlayerName,
    PlayerType,
    TrackStatus,
    playItunesTrackNumberInPlaylist,
    getRunningTrack,
    launchAndPlaySpotifyTrack,
    playSpotifyMacDesktopTrack
} from "cody-music";
import { MusicControlManager } from "./MusicControlManager";
import { SPOTIFY_LIKED_SONGS_PLAYLIST_NAME } from "../Constants";
import { MusicManager } from "./MusicManager";

/**
 * Create the playlist tree item (root or leaf)
 * @param p
 * @param cstate
 */
const createPlaylistTreeItem = (
    p: PlaylistItem,
    cstate: TreeItemCollapsibleState
) => {
    return new PlaylistTreeItem(p, cstate);
};

let checkSpotifyStateTimeout = null;

export const checkSpotifySongState = (trackId: string) => {
    if (checkSpotifyStateTimeout) {
        clearTimeout(checkSpotifyStateTimeout);
    }
    checkSpotifyStateTimeout = setTimeout(async () => {
        // make sure we get that song, if not then they may not be logged in
        let playingTrack = await getRunningTrack();

        if (!playingTrack || playingTrack.id !== trackId) {
            // they're not logged in
            window.showInformationMessage(
                "We're unable to play the selected Spotify track. Please make sure you are logged in to your account. You will need the Spotify desktop app if you have a non-premium Spotify account.",
                ...["Ok"]
            );
        }
    }, 5500);
};

export const playSelectedItem = async (
    playlistItem: PlaylistItem,
    isExpand = true
) => {
    const musicCtrlMgr = new MusicControlManager();
    const musicMgr = MusicManager.getInstance();
    if (playlistItem.type === "track") {
        let currentPlaylistId = playlistItem["playlist_id"];

        musicMgr.selectedTrackItem = playlistItem;
        if (!musicMgr.selectedPlaylist) {
            const playlist: PlaylistItem = await musicMgr.getPlaylistById(
                currentPlaylistId
            );
            musicMgr.selectedPlaylist = playlist;
        }

        const notPlaying =
            playlistItem.state !== TrackStatus.Playing ? true : false;

        const isLikedSongsPlaylist =
            musicMgr.selectedPlaylist.name === SPOTIFY_LIKED_SONGS_PLAYLIST_NAME
                ? true
                : false;

        if (playlistItem.playerType === PlayerType.MacItunesDesktop) {
            if (notPlaying) {
                const pos: number = playlistItem.position || 1;
                await playItunesTrackNumberInPlaylist(
                    musicMgr.selectedPlaylist.name,
                    pos
                );
            } else {
                musicCtrlMgr.pauseSong(PlayerName.ItunesDesktop);
            }
        } else if (musicMgr.currentPlayerName === PlayerName.SpotifyDesktop) {
            // ex: ["spotify:track:0R8P9KfGJCDULmlEoBagcO", "spotify:playlist:6ZG5lRT77aJ3btmArcykra"]
            // make sure the track has spotify:track and the playlist has spotify:playlist

            if (isLikedSongsPlaylist) {
                // send the track id
                playSpotifyMacDesktopTrack(playlistItem.id);
            } else {
                // send the track id and playlist id
                playSpotifyMacDesktopTrack(
                    playlistItem.id,
                    musicMgr.selectedPlaylist.id
                );
            }
            checkSpotifySongState(playlistItem.id);
        } else {
            if (notPlaying) {
                await launchAndPlaySpotifyTrack(
                    playlistItem.id,
                    currentPlaylistId
                );
                // await launchAndPlayTrack(playlistItem, musicMgr.spotifyUser);
            } else {
                musicCtrlMgr.pauseSong(musicMgr.currentPlayerName);
            }
        }
    } else {
        // to play a playlist
        // {device_id: <spotify_device_id>,
        //   uris: ["spotify:track:4iV5W9uYEdYUVa79Axb7Rh", "spotify:track:1301WleyT98MSxVHPZCA6M"],
        //   context_uri: <playlist_uri, album_uri>}
        musicMgr.selectedPlaylist = playlistItem;

        if (!isExpand) {
            // get the tracks
            const tracks: PlaylistItem[] = await MusicManager.getInstance().getPlaylistItemTracksForPlaylistId(
                playlistItem.id
            );

            // get the tracks
            const selectedTrack: PlaylistItem =
                tracks && tracks.length > 0 ? tracks[0] : null;

            const isLikedSongsPlaylist =
                playlistItem.name === SPOTIFY_LIKED_SONGS_PLAYLIST_NAME
                    ? true
                    : false;

            if (playlistItem.playerType === PlayerType.MacItunesDesktop) {
                const pos: number = 1;
                await playItunesTrackNumberInPlaylist(
                    musicMgr.selectedPlaylist.name,
                    pos
                );
            } else {
                if (!selectedTrack) {
                    return;
                }

                if (musicMgr.currentPlayerName === PlayerName.SpotifyDesktop) {
                    if (isLikedSongsPlaylist) {
                        // just play the 1st track
                        playSpotifyMacDesktopTrack(selectedTrack.id);
                    } else {
                        // ex: ["spotify:track:0R8P9KfGJCDULmlEoBagcO", "spotify:playlist:6ZG5lRT77aJ3btmArcykra"]
                        // make sure the track has spotify:track and the playlist has spotify:playlist
                        playSpotifyMacDesktopTrack(
                            selectedTrack.id,
                            playlistItem.id
                        );
                    }
                    checkSpotifySongState(selectedTrack.id);
                } else {
                    if (isLikedSongsPlaylist) {
                        // play the 1st track in the non-playlist liked songs folder
                        if (selectedTrack) {
                            await launchAndPlaySpotifyTrack(
                                selectedTrack.id,
                                playlistItem.id
                            );
                        }
                    } else {
                        // use the normal play playlist by offset 0 call
                        await launchAndPlaySpotifyTrack("", playlistItem.id);
                    }

                    if (selectedTrack) {
                        musicMgr.selectedTrackItem = selectedTrack;
                    }
                }
            }
        }
    }
};

/**
 * Handles the playlist onDidChangeSelection event
 */
export const connectPlaylistTreeView = (view: TreeView<PlaylistItem>) => {
    return Disposable.from(
        view.onDidChangeSelection(async e => {
            if (!e.selection || e.selection.length === 0) {
                return;
            }
            let playlistItem: PlaylistItem = e.selection[0];

            if (playlistItem.command) {
                // run the command
                commands.executeCommand(playlistItem.command);
                return;
            } else if (playlistItem["cb"]) {
                const cbFunc = playlistItem["cb"];
                cbFunc();
                return;
            }

            // play it
            playSelectedItem(playlistItem);
        }),
        view.onDidChangeVisibility(e => {
            if (e.visible) {
                //
            }
        })
    );
};
export class MusicPlaylistProvider implements TreeDataProvider<PlaylistItem> {
    private _onDidChangeTreeData: EventEmitter<
        PlaylistItem | undefined
    > = new EventEmitter<PlaylistItem | undefined>();

    readonly onDidChangeTreeData: Event<PlaylistItem | undefined> = this
        ._onDidChangeTreeData.event;

    private view: TreeView<PlaylistItem>;

    constructor() {
        //
    }

    bindView(view: TreeView<PlaylistItem>): void {
        console.log(`binded view: ${JSON.stringify(view)}`);
        this.view = view;
    }

    getParent(_p: PlaylistItem) {
        return void 0; // all playlists are in root
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    refreshParent(parent: PlaylistItem) {
        this._onDidChangeTreeData.fire(parent);
    }

    isTrackInPlaylistRunning(p: PlaylistItem) {
        return (
            p.state === TrackStatus.Playing || p.state === TrackStatus.Paused
        );
    }

    getTreeItem(p: PlaylistItem): PlaylistTreeItem {
        let treeItem: PlaylistTreeItem = null;
        if (p.type === "playlist") {
            // it's a track parent (playlist)
            if (p && p.tracks && p.tracks["total"] && p.tracks["total"] > 0) {
                const folderState: TreeItemCollapsibleState = this.isTrackInPlaylistRunning(
                    p
                )
                    ? TreeItemCollapsibleState.Expanded
                    : TreeItemCollapsibleState.Collapsed;
                return createPlaylistTreeItem(p, folderState);
            }
            treeItem = createPlaylistTreeItem(p, TreeItemCollapsibleState.None);
        } else {
            // it's a track or a title
            treeItem = createPlaylistTreeItem(p, TreeItemCollapsibleState.None);

            // reveal the track state if it's playing or paused
            if (
                this.isTrackInPlaylistRunning(p) &&
                this.view &&
                this.view.selection &&
                this.view.selection.length > 0
            ) {
                try {
                    // don't "select" it though. that will invoke the pause/play action
                    this.view.reveal(p, {
                        focus: true,
                        select: false
                    });
                } catch (err) {
                    console.log(
                        "Unable to reveal running track, error: ",
                        err.message
                    );
                }
            }
        }

        return treeItem;
    }

    async getChildren(element?: PlaylistItem): Promise<PlaylistItem[]> {
        const musicMgr: MusicManager = MusicManager.getInstance();

        if (element) {
            // return track of the playlist parent
            let tracks: PlaylistItem[] = await musicMgr.getPlaylistItemTracksForPlaylistId(
                element.id
            );
            return tracks;
        } else {
            // get the top level playlist parents
            let playlistChildren: PlaylistItem[] = musicMgr.currentPlaylists;
            if (!playlistChildren || playlistChildren.length === 0) {
                // try again if we've just initialized the plugin
                await musicMgr.refreshPlaylists();
                playlistChildren = musicMgr.currentPlaylists;
            }
            return musicMgr.currentPlaylists;
        }
    }
}

/**
 * The TreeItem contains the "contextValue", which is represented as the "viewItem"
 * from within the package.json when determining if there should be decoracted context
 * based on that value.
 */
export class PlaylistTreeItem extends TreeItem {
    private resourcePath: string = path.join(
        __filename,
        "..",
        "..",
        "..",
        "resources"
    );

    constructor(
        private readonly treeItem: PlaylistItem,
        public readonly collapsibleState: TreeItemCollapsibleState,
        public readonly command?: Command
    ) {
        super(treeItem.name, collapsibleState);

        // set the track's context value to the playlist item state
        // if it's a track that's playing or paused it will show the appropriate button.
        // if it's a playlist folder that has a track that is playing or paused it will show the appropriate button
        const stateVal =
            treeItem.state !== TrackStatus.Playing ? "notplaying" : "playing";
        this.contextValue = "";
        if (treeItem.tag === "action") {
            this.contextValue = "treeitem-action";
        } else if (
            treeItem["itemType"] === "track" ||
            treeItem["itemType"] === "playlist"
        ) {
            this.contextValue = `${treeItem.tag}-${treeItem.type}-item-${stateVal}`;
        }

        if (treeItem.tag === "spotify" || treeItem.type === "spotify") {
            this.iconPath.light = path.join(
                this.resourcePath,
                "light",
                "spotify-logo.svg"
            );
            this.iconPath.dark = path.join(
                this.resourcePath,
                "dark",
                "spotify-logo.svg"
            );
        } else if (treeItem.tag === "itunes" || treeItem.type === "itunes") {
            this.iconPath.light = path.join(
                this.resourcePath,
                "light",
                "itunes-logo.svg"
            );
            this.iconPath.dark = path.join(
                this.resourcePath,
                "dark",
                "itunes-logo.svg"
            );
        } else if (treeItem.tag === "paw") {
            this.iconPath.light = path.join(
                this.resourcePath,
                "light",
                "sw-paw-circle.svg"
            );
            this.iconPath.dark = path.join(
                this.resourcePath,
                "dark",
                "sw-paw-circle.svg"
            );
        } else if (treeItem.type === "connected") {
            this.iconPath.light = path.join(
                this.resourcePath,
                "light",
                "radio-tower.svg"
            );
            this.iconPath.dark = path.join(
                this.resourcePath,
                "dark",
                "radio-tower.svg"
            );
        } else if (treeItem.type === "offline") {
            this.iconPath.light = path.join(
                this.resourcePath,
                "light",
                "nowifi.svg"
            );
            this.iconPath.dark = path.join(
                this.resourcePath,
                "dark",
                "nowifi.svg"
            );
        } else if (treeItem.type === "action" || treeItem.tag === "action") {
            this.iconPath.light = path.join(
                this.resourcePath,
                "light",
                "gear.svg"
            );
            this.iconPath.dark = path.join(
                this.resourcePath,
                "dark",
                "gear.svg"
            );
        } else if (treeItem.type === "login" || treeItem.tag === "login") {
            this.iconPath.light = path.join(
                this.resourcePath,
                "light",
                "sign-in.svg"
            );
            this.iconPath.dark = path.join(
                this.resourcePath,
                "dark",
                "sign-in.svg"
            );
        } else if (treeItem.type === "divider") {
            this.iconPath.light = path.join(
                this.resourcePath,
                "light",
                "blue-line-96.png"
            );
            this.iconPath.dark = path.join(
                this.resourcePath,
                "dark",
                "blue-line-96.png"
            );
        } else {
            // no matching tag, remove the tree item icon path
            delete this.iconPath;
        }
    }

    get tooltip(): string {
        return `${this.treeItem.tooltip}`;
    }

    iconPath = {
        light: "",
        dark: ""
    };

    contextValue = "playlistItem";
}
