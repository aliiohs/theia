/********************************************************************************
 * Copyright (C) 2020 Ericsson and others.
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

import { injectable, inject, postConstruct } from 'inversify';
import { FileSystemWatcherClient, FileSystemWatcherServer2, FileSystemWatcherClient2, DidFilesChangedParams2 } from '../common/filesystem-watcher-protocol';

/**
 * This component routes watch events to the right clients.
 */
@injectable()
export class FileSystemWatcherServerDispatcher implements FileSystemWatcherClient2 {

    /**
     * Mapping of `clientId` to actual clients.
     */
    protected readonly clients = new Map<number, FileSystemWatcherClient>();

    @inject(FileSystemWatcherServer2)
    protected readonly watcherServer2: FileSystemWatcherServer2;

    @postConstruct()
    protected postConstruct(): void {
        this.watcherServer2.setClient(this);
    }

    onDidFilesChanged2(event: DidFilesChangedParams2): void {
        for (const clientId of event.clients) {
            const client = this.clients.get(clientId);
            if (typeof client !== 'undefined') {
                client.onDidFilesChanged(event);
            }
        }
    }

    registerClient(clientId: number, client: FileSystemWatcherClient): void {
        if (this.clients.has(clientId)) {
            throw new Error(`a client was already registered: clientId=${clientId}`);
        }
        this.clients.set(clientId, client);
    }

    unregisterClient(clientId: number): void {
        if (!this.clients.has(clientId)) {
            console.warn(`tried to remove unknown client: clientId=${clientId}`);
        }
        this.clients.delete(clientId);
    }
}
