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

import * as path from 'path';
import { ContainerModule, interfaces } from 'inversify';
import { ConnectionHandler, JsonRpcConnectionHandler, ILogger } from '@theia/core/lib/common';
import { FileSystemWatcherServer, FileSystemWatcherServer2 } from '../common/filesystem-watcher-protocol';
import { FileSystemWatcherServerClient } from './filesystem-watcher-client';
import { NsfwFileSystemWatcherServer } from './nsfw-watcher/nsfw-filesystem-watcher';
import { MessagingService } from '@theia/core/lib/node/messaging/messaging-service';
import { NodeFileUploadService } from './node-file-upload-service';
import { NsfwOptions } from './nsfw-watcher/nsfw-options';
import { DiskFileSystemProvider } from './disk-file-system-provider';
import {
    remoteFileSystemPath, RemoteFileSystemServer, RemoteFileSystemClient, FileSystemProviderServer, RemoteFileSystemProxyFactory
} from '../common/remote-file-system-provider';
import { FileSystemProvider } from '../common/files';
import { EncodingService } from '@theia/core/lib/common/encoding-service';
import { IPCConnectionProvider } from '@theia/core/lib/node';
import { JsonRpcProxyFactory, ConnectionErrorHandler } from '@theia/core';
import { FileSystemWatcherServerDispatcher } from './filesystem-watcher-dispatcher';

const SINGLE_THREADED = process.argv.indexOf('--no-cluster') !== -1;

export function bindFileSystemWatcherServer(bind: interfaces.Bind, { singleThreaded }: { singleThreaded: boolean } = { singleThreaded: SINGLE_THREADED }): void {
    bind(NsfwOptions).toConstantValue({});

    bind(FileSystemWatcherServerDispatcher).toSelf().inSingletonScope();

    bind(FileSystemWatcherServerClient).toSelf();
    bind(FileSystemWatcherServer).toService(FileSystemWatcherServerClient);

    if (singleThreaded) {
        bind(FileSystemWatcherServer2).toDynamicValue(ctx => {
            const logger = ctx.container.get<ILogger>(ILogger);
            const nsfwOptions = ctx.container.get<NsfwOptions>(NsfwOptions);
            return new NsfwFileSystemWatcherServer({
                nsfwOptions,
                info: (message, ...args) => logger.info(message, ...args),
                error: (message, ...args) => logger.error(message, ...args)
            });
        }).inSingletonScope();
    } else {
        bind(FileSystemWatcherServer2).toDynamicValue(ctx => {
            const proxyFactory = new JsonRpcProxyFactory<FileSystemWatcherServer2>();
            const proxy = proxyFactory.createProxy();
            const serverName = 'nsfw-watcher';
            const logger = ctx.container.get<ILogger>(ILogger);
            const nsfwOptions = ctx.container.get<NsfwOptions>(NsfwOptions);
            const ipcConnectionProvider = ctx.container.get<IPCConnectionProvider>(IPCConnectionProvider);
            ipcConnectionProvider.listen({
                serverName,
                entryPoint: path.resolve(__dirname, serverName),
                errorHandler: new ConnectionErrorHandler({
                    serverName,
                    logger,
                }),
                args: [
                    `--nsfwOptions=${JSON.stringify(nsfwOptions)}`
                ],
                env: process.env
            }, connection => proxyFactory.listen(connection));
            return proxy;
        }).inSingletonScope();
    }
}

export default new ContainerModule(bind => {
    bind(EncodingService).toSelf().inSingletonScope();
    bindFileSystemWatcherServer(bind);
    bind(DiskFileSystemProvider).toSelf();
    bind(FileSystemProvider).toService(DiskFileSystemProvider);
    bind(FileSystemProviderServer).toSelf();
    bind(RemoteFileSystemServer).toService(FileSystemProviderServer);
    bind(ConnectionHandler).toDynamicValue(ctx =>
        new JsonRpcConnectionHandler<RemoteFileSystemClient>(remoteFileSystemPath, client => {
            const server = ctx.container.get<RemoteFileSystemServer>(RemoteFileSystemServer);
            server.setClient(client);
            client.onDidCloseConnection(() => server.dispose());
            return server;
        }, RemoteFileSystemProxyFactory)
    ).inSingletonScope();
    bind(NodeFileUploadService).toSelf().inSingletonScope();
    bind(MessagingService.Contribution).toService(NodeFileUploadService);
});
