/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import {CancellationToken, CodeLens, Range, Position, Uri, TextDocument, CodeLensProvider} from 'vscode';
import {toRange} from '../omnisharp/typeConvertion';
import AbstractSupport from './abstractProvider';
//import {OmnisharpServer} from '../omnisharp/server';
import * as protocol from '../omnisharp/protocol';
import * as serverUtils from '../omnisharp/utils';
import {spawn} from 'child_process';
import {dirname} from 'path';
import * as moment from 'moment';

export class GitCodeLens extends CodeLens {
    constructor(public blame: Thenable<any>, public fileName: string, range: Range) {
        super(range);
        this.blame = blame;
        this.fileName = fileName;
    }
}

export declare interface IBlameLine {
    line: number;
    author: string;
    date: Date;
    sha: string;
    code: string;
}

export default class GitCodeLensProvider extends AbstractSupport implements CodeLensProvider {
    private static filteredSymbolNames: { [name: string]: boolean } = {
        'Equals': true,
        'Finalize': true,
        'GetHashCode': true,
        'ToString': true
    };

    // protected _repository: string;

    // constructor(repository: string, server: OmnisharpServer) {
    //     super(server);
    //     this._repository = repository;
    // }

    provideCodeLenses(document: TextDocument, token: CancellationToken): CodeLens[] | Thenable<CodeLens[]> {
        let blame = GitCodeLensProvider.gitBlame(document.fileName);

        let request = { Filename: document.fileName };
        return serverUtils.currentFileMembersAsTree(this._server, request, token).then(tree => {
            let lenses: CodeLens[] = [];
            tree.TopLevelTypeDefinitions.forEach(node => this._provideCodeLens(lenses, document.fileName, node, blame));
            return lenses;
        });
    }

    private _provideCodeLens(lenses: CodeLens[], fileName: string, node: protocol.Node, blame: Thenable<IBlameLine[]>): void {
        if (node.Kind === 'MethodDeclaration' && GitCodeLensProvider.filteredSymbolNames[node.Location.Text]) {
            return;
        }

        GitCodeLensProvider.provideCodeLens(lenses, fileName, node, blame);

        for (let child of node.ChildNodes) {
            this._provideCodeLens(lenses, fileName, child, blame);
        }
    }

    resolveCodeLens(codeLens: CodeLens, token: CancellationToken): Thenable<CodeLens> {
        return GitCodeLensProvider.resolveCodeLens(codeLens, token);
    }

    static provideCodeLens(lenses: CodeLens[], fileName: string, node: protocol.Node, blame: Thenable<IBlameLine[]>): void {
        let range: Range = toRange(node.Location);
        range.with({ start: new Position(node.Location.EndLine, node.Location.EndColumn - 1) });
        // if (node.ChildNodes.length) {
        //     let last = node;
        //     while (last.ChildNodes.length) {
        //         last = node.ChildNodes[node.ChildNodes.length - 1];
        //     }
        //     range = new Range(range.start, new Position(last.Location.EndLine, last.Location.EndColumn));
        // }

        let lens = new GitCodeLens(blame, fileName, range);
        lenses.push(lens);
    }

    static resolveCodeLens(codeLens: CodeLens, token: CancellationToken): Thenable<CodeLens> {
        if (codeLens instanceof GitCodeLens) {
            return codeLens.blame.then(allLines => {
                let lines = allLines.slice(codeLens.range.start.line, codeLens.range.end.line + 1);
                let line = lines[0];
                if (lines.length > 1) {
                    let sorted = lines.sort((a, b) => b.date - a.date);
                    line = sorted[0];
                }
                codeLens.command = {
                    title: `${line.author}, ${moment(line.date).fromNow()}`,
                    command: 'git.viewFileHistory',
                    arguments: [Uri.file(codeLens.fileName)]
                };
                return codeLens;
            });
        }
    }

    private static blameMatcher = /^(.*)\t\((.*)\t(.*)\t(.*?)\)(.*)$/gm;

    static gitBlame(fileName: string) {
        return new Promise<IBlameLine[]>((resolve, reject) => {
            let spawn = require('child_process').spawn;
            let process = spawn('git', ['blame', '-c', '-M', '-w', '--', fileName], { cwd: dirname(fileName) });

            let lines: IBlameLine[] = [];
            process.stdout.on('data', function (data) {
                let m: Array<string>;
                while ((m = GitCodeLensProvider.blameMatcher.exec(data.toString())) != null) {
                    lines.push({ sha: m[1], author: m[2], date: new Date(m[3]), line: parseInt(m[4], 10), code: m[5] });
                }
            });

            let err = "";
            process.stderr.on('data', function (data) {
                err += data;
            });

            process.on('exit', function (code) {
                if (err.length > 0) {
                    reject(err);
                    return;
                }

                resolve(lines);
            });
        });
    }
}
