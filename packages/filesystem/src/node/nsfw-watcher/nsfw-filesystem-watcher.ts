/********************************************************************************
 * Copyright (C) 2017-2018 TypeFox and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

import * as nsfw from 'nsfw';
import { join } from 'path';
import { promises as fsp } from 'fs';
import { IMinimatch, Minimatch } from 'minimatch';
import { Disposable, DisposableCollection } from '@theia/core/lib/common/disposable';
import { FileUri } from '@theia/core/lib/node/file-uri';
import {
    FileChangeType,
    FileSystemWatcherServer2,
    FileSystemWatcherClient2,
    WatchOptions
} from '../../common/filesystem-watcher-protocol';
import { FileChangeCollection } from '../file-change-collection';
import { Deferred } from '@theia/core/src/common/promise-util';

const debounce = require('lodash.debounce');

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface WatcherOptions {
    ignored: IMinimatch[]
}

/**
 * This is a flag value passed around upon disposal.
 */
export const WatcherDisposal = Symbol('WatcherDisposal');

/**
 * Because URIs can be watched by different clients, we'll track
 * how many are listening for a given URI.
 *
 * This component wraps the whole start/stop process given some
 * reference count.
 *
 * Once there are no more references the handle
 * will wait for some time before destroying its resources.
 */
export class Watcher {

    protected disposed = false;

    protected nsfw: nsfw.NSFW | undefined;

    /**
     * Amount of time to wait before disposing of the current handle.
     */
    protected readonly deferredDisposalTimeout: number;

    /**
     * When the ref count hits zero, we schedule this watch handle to be disposed.
     */
    protected deferredDisposalTimer: NodeJS.Timer | undefined;

    /**
     * This deferred only rejects with `WatcherDisposal` and never resolves.
     */
    protected readonly deferredDisposalDeferred = new Deferred<never>();

    /**
     * Track each client that uses the same watcher instance.
     *
     * Since a given client can also make duplicate watch requests for the same uri,
     * we need to keep track of those duplicated calls, per client.
     *
     * An entry should be removed when its value hits zero.
     */
    protected readonly clientReferences = new Map<number, { value: number }>();

    /**
     * The client to forward events to.
     */
    protected fileSystemWatcherClient: FileSystemWatcherClient2;

    /**
     * Filesystem path to be watched.
     */
    readonly fsPath: string;

    /**
     * Resolves once this handle disposed itself and its resources. Never throws.
     */
    readonly whenDisposed: Promise<void> = this.deferredDisposalDeferred.promise.catch(() => undefined);

    /**
     * Promise that resolves when the watcher is fully started.
     *
     * Will reject if an error occured, or will reject with `WatcherDisposal` if disposed while starting.
     */
    readonly started: Promise<void>;

    constructor(
        fsPath: string,
        initialClientId: number,
        fileSystemWatcherClient: FileSystemWatcherClient2,
        deferredDisposalTimeout = 1000,
    ) {
        this.fsPath = fsPath;
        this.deferredDisposalTimeout = deferredDisposalTimeout;
        this.fileSystemWatcherClient = fileSystemWatcherClient;
        this.clientReferences.set(initialClientId, { value: 1 });
        this.started = this.start().catch(error => {
            this._dispose();
            throw error;
        });
    }

    addRef(clientId: number): void {
        const revived = this.getTotalReferences() === 0;
        let refs = this.clientReferences.get(clientId);
        if (typeof refs === 'undefined') {
            this.clientReferences.set(clientId, refs = { value: 1 });
        }
        refs.value += 1;
        if (revived) {
            this.onRefsRevive();
        }
    }

    removeRef(clientId: number): void {
        const refs = this.clientReferences.get(clientId);
        if (typeof refs === 'undefined') {
            console.warn(`removed one too many reference to a watcher: clientId=${clientId}`);
            return;
        }
        refs.value -= 1;
        if (refs.value === 0) {
            this.clientReferences.delete(clientId);
        }
        if (this.getTotalReferences() === 0) {
            this.onRefsReachZero();
        }
    }

    protected async start(): Promise<void> {
        // Wait for the fsPath to exist, allow early cancellation:
        while (await this.orCancel(fsp.stat(this.fsPath).then(() => false, () => true))) {
            await this.orCancel(new Promise(resolve => setTimeout(resolve, 500)));
        }
        this.nsfw = await this.createNsfw();
    }

    protected async createNsfw(): Promise<nsfw.NSFW> {
        return nsfw(
            await fsp.realpath(this.fsPath),
            (events: nsfw.ChangeEvent[]) => this.handleNsfwEvents(events),
            {
                errorCallback: error => {
                    // see https://github.com/atom/github/issues/342
                    console.warn(`Failed to watch "${basePath}":`, error);
                    this.unwatchFileChanges2(watcherId);
                },
                ...this.options.nsfwOptions
            });
    }

    protected handleNsfwEvents(events: nsfw.ChangeEvent[]): void {
        const fileChangeCollection = new FileChangeCollection();
        for (const event of events) {
            if (event.action === nsfw.actions.CREATED) {
                this.pushAdded(watcherId, this.resolveEventPath(event.directory, event.file!));
            }
            if (event.action === nsfw.actions.DELETED) {
                this.pushDeleted(watcherId, this.resolveEventPath(event.directory, event.file!));
            }
            if (event.action === nsfw.actions.MODIFIED) {
                this.pushUpdated(watcherId, this.resolveEventPath(event.directory, event.file!));
            }
            if (event.action === nsfw.actions.RENAMED) {
                this.pushDeleted(watcherId, this.resolveEventPath(event.directory, event.oldFile!));
                this.pushAdded(watcherId, this.resolveEventPath(event.newDirectory || event.directory, event.newFile!));
            }
        }
        this.fileSystemWatcherClient.onDidFilesChanged2({
            clients: this.getClientIds(),
            changes: fileChangeCollection.values(),
        });
    }

    protected async resolveEventPath(directory: string, file: string): Promise<string> {
        const path = join(directory, file);
        try {
            return fsp.realpath(path);
        } catch {
            try {
                // file does not exist try to resolve directory
                return join(await fsp.realpath(directory), file);
            } catch {
                // directory does not exist fall back to symlink
                return path;
            }
        }
    }

    /**
     * All clients with at least one active reference.
     */
    protected getClientIds(): number[] {
        return Array.from(this.clientReferences.keys());
    }

    /**
     * Add the references for each client together.
     */
    protected getTotalReferences(): number {
        let total = 0;
        for (const refs of this.clientReferences.values()) {
            total += refs.value;
        }
        return total;
    }

    protected onRefsReachZero(): void {
        this.deferredDisposalTimer = setTimeout(() => this._dispose(), this.deferredDisposalTimeout);
    }

    protected onRefsRevive(): void {
        if (this.deferredDisposalTimer) {
            clearTimeout(this.deferredDisposalTimer);
            this.deferredDisposalTimer = undefined;
        }
    }

    /**
     * Internal disposal mechanism: do not call manually.
     */
    protected async _dispose(): Promise<void> {
        if (!this.disposed) {
            this.disposed = true;
            this.deferredDisposalDeferred.reject(WatcherDisposal);
        }
    }

    /**
     * Wrap a promise to reject as soon as this handle gets disposed.
     *
     * @param promise
     */
    protected async orCancel<T>(promise: Promise<T>): Promise<T> {
        return Promise.race<T>([promise, this.deferredDisposalDeferred.promise]);
    }
}

/**
 * Each time a client makes a watchRequest, we generate a unique watcherId for it.
 *
 * This watcherId will map to this handle type which keeps track of the clientId that made the request.
 */
export interface WatcherHandle {
    clientId: number;
    watcher: Watcher;
}

export class NsfwFileSystemWatcherServer implements FileSystemWatcherServer2 {

    protected client: FileSystemWatcherClient2 | undefined;

    protected watcherId = 0;
    protected readonly watchers = new Map<string, Watcher>();
    protected readonly watcherHandles = new Map<number, WatcherHandle>();

    protected readonly options: {
        verbose: boolean
        info: (message: string, ...args: any[]) => void
        error: (message: string, ...args: any[]) => void,
        nsfwOptions: nsfw.Options
    };

    constructor(options?: {
        verbose?: boolean,
        nsfwOptions?: nsfw.Options,
        info?: (message: string, ...args: any[]) => void
        error?: (message: string, ...args: any[]) => void
    }) {
        this.options = {
            nsfwOptions: {},
            verbose: false,
            info: (message, ...args) => console.info(message, ...args),
            error: (message, ...args) => console.error(message, ...args),
            ...options
        };
    }

    dispose(): void {
        // Singletons shouldn't be disposed...
    }

    async watchFileChanges2(clientId: number, uri: string, options?: WatchOptions): Promise<number> {
        const resolvedOptions = this.resolveWatchOptions(options);
        const watcherKey = this.getWatcherKey(uri, resolvedOptions);
        let watcher = this.watchers.get(watcherKey);
        if (typeof watcher === 'undefined') {
            const fsPath = FileUri.fsPath(uri);
            watcher = new Watcher(fsPath, clientId, this.client);
            watcher.whenDisposed.then(() => this.watchers.delete(watcherKey));
            this.watchers.set(watcherKey, watcher);
        } else {
            watcher.addRef(clientId);
        }
        const watcherId = this.watcherId++;
        this.watcherHandles.set(watcherId, { clientId, watcher });
        watcher.whenDisposed.then(() => this.watcherHandles.delete(watcherId));
        return watcherId;
    }

    async unwatchFileChanges2(watcherId: number): Promise<void> {
        const handle = this.watcherHandles.get(watcherId);
        if (typeof handle === 'undefined') {
            console.warn(`tried to de-allocate a disposed watcher: watcherId=${watcherId}`);
        } else {
            this.watcherHandles.delete(watcherId);
            handle.watcher.removeRef(handle.clientId);
        }
    }

    /**
     * Given some URI and some Options, generate a unique key.
     *
     * @param uri
     * @param options
     */
    protected getWatcherKey(uri: string, options: WatchOptions): string {
        return [
            uri,
            options.ignored.slice(0).sort().join()  // use a **sorted copy** of `ignored` as part of the key
        ].join();
    }

    /**
     * Return fully qualified options.
     *
     * @param options
     */
    protected resolveWatchOptions(options?: WatchOptions): WatchOptions {
        return {
            ignored: [],
            ...options,
        };
    }

    protected async start(watcherId: number, basePath: string, options: WatchOptions, toDisposeWatcher: DisposableCollection): Promise<void> {
        if (options.ignored.length > 0) {
            this.debug('Files ignored for watching', options.ignored);
        }
        let watcher: nsfw.NSFW | undefined = await nsfw(fs.realpathSync(basePath), (events: nsfw.ChangeEvent[]) => {
            for (const event of events) {
                if (event.action === nsfw.actions.CREATED) {
                    this.pushAdded(watcherId, this.resolvePath(event.directory, event.file!));
                }
                if (event.action === nsfw.actions.DELETED) {
                    this.pushDeleted(watcherId, this.resolvePath(event.directory, event.file!));
                }
                if (event.action === nsfw.actions.MODIFIED) {
                    this.pushUpdated(watcherId, this.resolvePath(event.directory, event.file!));
                }
                if (event.action === nsfw.actions.RENAMED) {
                    this.pushDeleted(watcherId, this.resolvePath(event.directory, event.oldFile!));
                    this.pushAdded(watcherId, this.resolvePath(event.newDirectory || event.directory, event.newFile!));
                }
            }
        }, {
            errorCallback: error => {
                // see https://github.com/atom/github/issues/342
                console.warn(`Failed to watch "${basePath}":`, error);
                this.unwatchFileChanges2(watcherId);
            },
            ...this.options.nsfwOptions
        });
        await watcher.start();
        this.options.info('Started watching:', basePath);
        if (toDisposeWatcher.disposed) {
            this.debug('Stopping watching:', basePath);
            await watcher.stop();
            // remove a reference to nsfw otherwise GC cannot collect it
            watcher = undefined;
            this.options.info('Stopped watching:', basePath);
            return;
        }
        toDisposeWatcher.push(Disposable.create(async () => {
            this.watcherOptions.delete(watcherId);
            if (watcher) {
                this.debug('Stopping watching:', basePath);
                await watcher.stop();
                // remove a reference to nsfw otherwise GC cannot collect it
                watcher = undefined;
                this.options.info('Stopped watching:', basePath);
            }
        }));
        this.watcherOptions.set(watcherId, {
            ignored: options.ignored.map(pattern => new Minimatch(pattern, { dot: true }))
        });
    }

    setClient(client: FileSystemWatcherClient2 | undefined): void {
        // if (client && this.toDispose.disposed) {
        //     return;
        // }
        this.client = client;
    }

    protected pushAdded(watcherId: number, path: string): void {
        this.debug('Added:', path);
        this.pushFileChange(watcherId, path, FileChangeType.ADDED);
    }

    protected pushUpdated(watcherId: number, path: string): void {
        this.debug('Updated:', path);
        this.pushFileChange(watcherId, path, FileChangeType.UPDATED);
    }

    protected pushDeleted(watcherId: number, path: string): void {
        this.debug('Deleted:', path);
        this.pushFileChange(watcherId, path, FileChangeType.DELETED);
    }

    protected pushFileChange(watcherId: number, path: string, type: FileChangeType): void {
        if (this.isIgnored(watcherId, path)) {
            return;
        }

        const uri = FileUri.create(path).toString();
        this.changes.push({ uri, type });

        this.fireDidFilesChanged();
    }

    protected resolvePath(directory: string, file: string): string {
        const path = paths.join(directory, file);
        try {
            return fs.realpathSync(path);
        } catch {
            try {
                // file does not exist try to resolve directory
                return paths.join(fs.realpathSync(directory), file);
            } catch {
                // directory does not exist fall back to symlink
                return path;
            }
        }
    }

    /**
     * Fires file changes to clients.
     * It is debounced in the case if the filesystem is spamming to avoid overwhelming clients with events.
     */
    protected readonly fireDidFilesChanged: () => void = debounce(() => this.doFireDidFilesChanged(), 50);
    protected doFireDidFilesChanged(): void {
        const changes = this.changes.values();
        this.changes = new FileChangeCollection();
        const event = { clients: [], changes };
        if (this.client) {
            this.client.onDidFilesChanged2(event);
        }
    }

    protected isIgnored(watcherId: number, path: string): boolean {
        const options = this.watcherOptions.get(watcherId);
        return !!options && options.ignored.length > 0 && options.ignored.some(m => m.match(path));
    }

    protected debug(message: string, ...params: any[]): void {
        if (this.options.verbose) {
            this.options.info(message, ...params);
        }
    }
}
