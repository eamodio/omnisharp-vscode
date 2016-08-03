/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import {CancellationToken, CodeLens, Range, Uri, TextDocument, CodeLensProvider, workspace} from 'vscode';
import {toRange, toLocation} from '../omnisharp/typeConvertion';
import AbstractSupport from './abstractProvider';
import GitCodeLensProvider, {IBlameLine} from './gitCodeLensProvider';
import {OmnisharpServer} from '../omnisharp/server';
import {updateCodeLensForTest} from './dotnetTest';
import * as protocol from '../omnisharp/protocol';
import * as serverUtils from '../omnisharp/utils';

class UsagesCodeLens extends CodeLens {
    constructor(public fileName: string, range: Range) {
        super(range);
        this.fileName = fileName;
    }
}

export default class UsagesCodeLensProvider extends AbstractSupport implements CodeLensProvider {
    private static filteredSymbolNames: { [name: string]: boolean } = {
        'Equals': true,
        'Finalize': true,
        'GetHashCode': true,
        'ToString': true
    };

    // protected _gitCodeLensProvider: GitCodeLensProvider;
    private _gitCodeLensEnabled: boolean;

    constructor(server: OmnisharpServer) {
        super(server);
        this._gitCodeLensEnabled = !workspace.getConfiguration().get('csharp.disableGitCodeLens', false);
        //this._gitCodeLensProvider = new GitCodeLensProvider(server);
    }

    provideCodeLenses(document: TextDocument, token: CancellationToken): CodeLens[] | Thenable<CodeLens[]> {
        let request = { Filename: document.fileName };

        let blame = this._gitCodeLensEnabled && GitCodeLensProvider.gitBlame(document.fileName);

        //let changes = this._gitCodeLensProvider && this._gitCodeLensProvider.provideCodeLenses(document, token) as Thenable<CodeLens[]>;

        return serverUtils.currentFileMembersAsTree(this._server, request, token).then(tree => {
            let lenses: CodeLens[] = [];
            tree.TopLevelTypeDefinitions.forEach(node => this._provideCodeLens(lenses, document.fileName, node, blame));
            return lenses;
        });
    }

    private _provideCodeLens(lenses: CodeLens[], fileName: string, node: protocol.Node, blame: Thenable<IBlameLine[]>): void {
        if (node.Kind === 'MethodDeclaration' && UsagesCodeLensProvider.filteredSymbolNames[node.Location.Text]) {
            return;
        }

        let lens = new UsagesCodeLens(fileName, toRange(node.Location));
        lenses.push(lens);

        for (let child of node.ChildNodes) {
            this._provideCodeLens(lenses, fileName, child, blame);
        }

        if (this._gitCodeLensEnabled) {
            GitCodeLensProvider.provideCodeLens(lenses, fileName, node, blame);
        }

        updateCodeLensForTest(lenses, fileName, node, this._server.isDebugEnable());
    }

    resolveCodeLens(codeLens: CodeLens, token: CancellationToken): Thenable<CodeLens> {
        if (codeLens instanceof UsagesCodeLens) {
            let req = <protocol.FindUsagesRequest>{
                Filename: codeLens.fileName,
                Line: codeLens.range.start.line + 1,
                Column: codeLens.range.start.character + 1,
                OnlyThisFile: false,
                ExcludeDefinition: true
            };

            return serverUtils.findUsages(this._server, req, token).then(res => {
                if (!res || !Array.isArray(res.QuickFixes)) {
                    return;
                }

                let len = res.QuickFixes.length;
                codeLens.command = {
                    title: len === 1 ? '1 reference' : `${len} references`,
                    command: 'editor.action.showReferences',
                    arguments: [Uri.file(req.Filename), codeLens.range.start, res.QuickFixes.map(toLocation)]
                };

                return codeLens;
            });
        }

        if (this._gitCodeLensEnabled) {
            return GitCodeLensProvider.resolveCodeLens(codeLens, token);
        }
    }
}
