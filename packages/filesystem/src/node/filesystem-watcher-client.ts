/********************************************************************************
 * Copyright (C) 2017 TypeFox and others.
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

import { injectable, inject } from 'inversify';
import { FileSystemWatcherServer, WatchOptions, FileSystemWatcherClient, FileSystemWatcherServer2 } from '../common/filesystem-watcher-protocol';
import { MessagingSessionId } from '@theia/core/src/node/messaging/messaging-contribution';
import { FileSystemWatcherServerDispatcher } from './filesystem-watcher-dispatcher';

export const NSFW_WATCHER = 'nsfw-watcher';

/**
 * Wraps the NSFW singleton server for each frontend.
 */
@injectable()
export class FileSystemWatcherServerClient implements FileSystemWatcherServer {

    /**
     * Track allocated watcherIds to de-allocate on disposal.
     */
    protected watcherIds = new Set<number>();

    @inject(MessagingSessionId)
    protected readonly sessionId: MessagingSessionId;

    @inject(FileSystemWatcherServerDispatcher)
    protected readonly watcherDispatcher: FileSystemWatcherServerDispatcher;

    @inject(FileSystemWatcherServer2)
    protected readonly watcherServer: FileSystemWatcherServer2;

    async watchFileChanges(uri: string, options?: WatchOptions): Promise<number> {
        const watcherId = await this.watcherServer.watchFileChanges2(this.sessionId, uri, options);
        this.watcherIds.add(watcherId);
        return watcherId;
    }

    async unwatchFileChanges(watcherId: number): Promise<void> {
        this.watcherIds.delete(watcherId);
        return this.watcherServer.unwatchFileChanges2(watcherId);
    }

    setClient(client: FileSystemWatcherClient | undefined): void {
        if (typeof client !== 'undefined') {
            this.watcherDispatcher.registerClient(this.sessionId, client);
        } else {
            this.watcherDispatcher.unregisterClient(this.sessionId);
        }
    }

    dispose(): void {
        this.setClient(undefined);
        for (const watcherId of this.watcherIds) {
            this.unwatchFileChanges(watcherId);
        }
    }
}
