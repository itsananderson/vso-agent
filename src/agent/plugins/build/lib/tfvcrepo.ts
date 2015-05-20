// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
import shell = require('shelljs');
import path = require('path');
import fs = require('fs');
import async = require('async');
import utilm = require('../../../utilities');
var xr = require('xmlreader');

interface TfvcMapping {
    type: string;
    serverPath: string;
    localPath: string;
}

interface Workspace {
    name: string;
    maps: TfvcMapping[];
    cloaks: TfvcMapping[];
}

var success = function(ret) {
    return ret && ret.code  === 0;
};

function _tfCmdExecutor(ctx, options) {
    return function(cmd, args, callback) {
        var getCmdline = function(cmd, arguments) {
            return 'tf ' + cmd + ' ' + arguments.join(' ');
        };

        var collectionArg = '-collection:' + options.collectionUri;
        var loginArg = '-login:' + options.creds.username + ',' + options.creds.password; 
        var arguments = args.concat([collectionArg, loginArg]);
        var cmdline = getCmdline(cmd, arguments);

        var maskedArguments = args.concat([collectionArg, '-login:********']);
        var maskedCmdline = getCmdline(cmd, maskedArguments);

        ctx.info('[command]' + maskedCmdline);
        utilm
           .exec(cmdline)
           .done(function (ret) {
               callback(ret); 
           });
    };
}

function _getWorkspaceFromXml(xmlNode) {
    var workspace: Workspace  = {
        name: xmlNode.attributes()['name'],
        maps: [],
        cloaks: []
    };

    if (xmlNode['working-folder']) {
        xmlNode['working-folder'].each((i, folder) => {
            var item = { 
                serverPath: folder.attributes()['server-item'], 
                localPath: folder.attributes()['local-item'],
                type: folder.attributes()['type']
            };

            if (item.type === 'map') {
                workspace.maps.push(item);
            } else if (item.type === 'cloak') {
                workspace.cloaks.push(item);
            }
        });
    }

    return workspace;
}

function _getWorkspace(tfCmdExecutor, workspaceName, callback) {
    var hostname = require('os').hostname();
    tfCmdExecutor('workspaces', ['-format:xml', '-computer:'+hostname], (ret) => {
        var workspace = null;

        if (success(ret) && ret.output) {
            xr.read(ret.output, (err, res) => {
                res.workspaces.workspace.each((i, ws) => { 
                    if (ws.attributes()['name'] === workspaceName 
                            && ws.attributes()['computer'] === hostname) {
                         workspace = _getWorkspaceFromXml(ws); 
                    }
                });
                callback(workspace);
            });
        } else {
            callback(null);
        }
    });
}

function _deleteWorkspace(tfCmdExecutor, workspace, callback) {
    tfCmdExecutor('workspace', ['-delete', workspace], callback);
}

function _newWorkspace(tfCmdExecutor, workspace, callback) {
    tfCmdExecutor("workspace", ['-new', '-permission:Public', workspace], callback);
}

function _get(tfCmdExecutor, version, callback) {
    tfCmdExecutor('get', ['.', '-recursive', '-version:' + version, '-noprompt'], callback);
}

function _cloakFolder(tfCmdExecutor, serverPath, workspace, callback) {
     tfCmdExecutor('workfold', ['-cloak', serverPath, '-workspace:' + workspace], callback);
}

function _decloakFolder(tfCmdExecutor, serverPath, workspace, callback) {
     tfCmdExecutor('workfold', ['-decloak', serverPath, '-workspace:' + workspace], callback);
}

function _mapFolder(tfCmdExecutor, serverPath, localPath, workspace, callback) {
    tfCmdExecutor('workfold', ['-map', serverPath, localPath, '-workspace:' + workspace], callback);
}

function _unmapFolder(tfCmdExecutor, serverPath, workspace, callback) {
    tfCmdExecutor('workfold', ['-unmap', serverPath, '-workspace:' + workspace], callback);
}

function _unshelve(tfCmdExecutor, shelveset, workspace, callback) {
    tfCmdExecutor('unshelve', ['-recursive', '-format:detailed', '-workspace:' + workspace, '"'+shelveset+'"'], callback);
}

function _undo(tfCmdExecutor, callback) {
    tfCmdExecutor('undo', ['-recursive', '.'], callback);
}

export function getcode(ctx, options, callback) {
    ctx.verbose('cwd: ' + process.cwd());
    var tf = shell.which('tf');
    if (!tf) {
        var msg = 'tf is not installed, please install Microsoft Team Explorer Everywhere Cross Platorm command-line client, and add it to PATH.';
        ctx.error(msg);
        callback(new Error(msg));
        return;
    }

    var createLocalPath = function (workspace, serverPath, callback) {
        var rootingWildCard = function (str) {
            if (str.indexOf('*') > -1) {
                return str.slice(0, str.indexOf('*'));
            }
            return str;
        };

        ctx.verbose('resolving local folder path for: ' + serverPath);
        var rootedServerPath = rootingWildCard(serverPath);
        ctx.verbose('Wildcard rooted server path: ' + rootedServerPath);

        var localPath = path.join(process.cwd(), workspace.name, rootedServerPath);
        ctx.verbose('resolved local folder path:' + localPath);

        if (!fs.existsSync(localPath)) {
            shell.mkdir('-p', localPath);
            var errMsg = shell.error();
            if (errMsg) {
                callback(null);
                return;
            }
        }

        callback(localPath);
    };

    var handler = function (res, predicate, extension, callback) {
        if (predicate()) {
            if (extension) {
                extension();
            }
            callback(null);
        } else {
            callback(res);
        }
    };

    var asyncHandler = function (err, callback) {
        handler(
            err, 
            () => { return err === null; }, 
            null, 
            callback);
    };

    var tfCmdHandler = function (ret, callback, errMsg, successExt = null) {
        if (ret && ret.output) {
            //show tf cmd output
            if (ret.code !== 0) {
                ctx.error(ret.output);
            } else {
                ctx.info(ret.output);
            }
        }

        handler(
            errMsg, 
            () => { return success(ret); }, 
            () => { if (successExt) {successExt(ret);} }, 
            callback);
    };

    var workspace: Workspace;
    var localPaths: string[] = [];
    var tfExecutor = _tfCmdExecutor(ctx, options);
    var workspaceName = options.workspace;
    var mappings = options.mappings;
    var changeSetVersion = options.version;
    var shelveSet = options.shelveset;

    async.series([
        // get existing workspace
        function (complete) {
            ctx.section('Setup workspace');
            _getWorkspace(tfExecutor, workspaceName, (ws) => {
                workspace = ws;
                if (workspace) {
                    ctx.info("workspace " + workspace.name + " exists.");
                    ctx.verbose(JSON.stringify(workspace));
                }

                complete(null);
            });
        },
        // if workspace exists and clean repo option is seleted, delete 
        // the current workspace and remove all local files;
        // otherwise just fall through
        function (complete) {
            if (workspace && options.clean) {
                ctx.info("Clean repo set, deleting workspace: " + workspace.name);
                ctx.info('rm -fr ' + workspace.name);
                utilm
                    .exec('rm -fr ' + workspace.name)
                    .done((res) => {
                        if (res.code !== 0) {
                            ctx.error(res.output);
                            complete('Failed to clean workspace.');
                            return;
                        }

                        _deleteWorkspace(tfExecutor, workspaceName, (ret) => {
                            tfCmdHandler(ret, complete, "Failed to clean workspace: " + workspaceName, () => {
                                ctx.info(workspaceName + ' deleted.');
                                workspace = null;
                            });
                        });
                });
            } else {
                complete(null);
            }
        },
        // create new workspace if workspace is null
        function (complete) {
            if (workspace) {
                ctx.verbose(workspaceName + ' exists, skip creating.');
                complete(null);
                return;
            }

            _newWorkspace(tfExecutor, workspaceName, (ret) => {
                workspace = {
                    name: workspaceName,
                    maps: [],
                    cloaks: []
                };

                tfCmdHandler(ret, complete, "Failed to create workspace.");
            });
        },
        // decloak all current cloaks 
        function (complete) {
            ctx.section('Setup workspace mappings');
            // workspace must exists by now
            if (!workspace) {
                complete('Failed to locate workspace ' + workspaceName);
                return;
            }

            if (workspace.cloaks.length === 0) {
                // nothing to decloak
                complete(null);
                return;
            }

            async.forEachSeries(workspace.cloaks, (cloak, myCallback) => {
                _decloakFolder(tfExecutor, cloak.serverPath, workspace.name, (ret) => {
                    tfCmdHandler(ret, myCallback, "Failed to decloak: " + cloak.serverPath);
                });
            }, (err) => {
                asyncHandler(err, complete);
            });
        },
        // unmap all current mappings (no need to figure out what has changed in build definition)
        function (complete) {
            // must have a workspace at this point
            if (workspace.maps.length === 0) {
                // nothing to map
                complete(null);
                return;
            }

            async.forEachSeries(workspace.maps, (map, myCallback) => {
                _unmapFolder(tfExecutor, map.serverPath, workspace.name, (ret) => {
                    tfCmdHandler(ret, myCallback, "Failed to remove mapping: " + map.serverPath);
                });
            }, (err) => {
                asyncHandler(err, complete);
            });
        },
        // map all mappings and cloaks
        function (complete) {
            if (!mappings) {
                // nothing to map?  Probably an user mistake, but just fall through anyway
                complete(null);
                return;
            }

            async.forEachSeries(mappings, (mapping, myCallback) => {
                if (mapping['mappingType'] === 'map') {
                    createLocalPath(workspace, mapping['serverPath'], (localPath) => {
                        if (localPath) {
                            ctx.info('Mapping ' + mapping['serverPath'] + ' to ' + localPath);
                            _mapFolder(tfExecutor, mapping['serverPath'], localPath, workspace.name, (ret) => {
                                tfCmdHandler(ret, myCallback, "Failed to create map: " + mapping['serverPath'], () => {
                                    localPaths.push(localPath);
                                });
                            });
                        } else {
                            myCallback('Failed to create a local folder to map: ' + mapping['serverPath'], null);                               
                        }
                    });
                } else if (mapping['mappingType'] === 'cloak') {
                    ctx.info('Cloaking ' + mapping['serverPath']);
                    _cloakFolder(tfExecutor, mapping['serverPath'], workspace.name, (ret) => {
                        tfCmdHandler(ret, myCallback, "Failed to cloak: " + mapping['serverPath']);
                    });
                }
            }, (err) => {
                asyncHandler(err, complete);
            });
        },
        // call tf get on all localPaths
        function (complete) {
            ctx.section('Get files');
            async.forEachSeries(localPaths, (localPath, myCallback) => {
                shell.pushd(localPath);
                ctx.info('cwd: ' + process.cwd());
                // first undo any pending changes introduced by any build
                _undo(tfExecutor, (ret) => {
                    // ignore return code, as the return is not 0 when there is nothing to undo
                    if (success(ret)) {
                        ctx.info(ret.output);
                    }

                    _get(tfExecutor, changeSetVersion, (ret) => {
                        shell.popd();
                        tfCmdHandler(ret, myCallback, "Failed to get files.");
                    });
                });
            }, (err) => {
               asyncHandler(err, complete);
            });
        },
        function (complete) {
            if (shelveSet) {
                ctx.info('Unshelving shelveset: '+shelveSet);
                _unshelve(tfExecutor, shelveSet, workspace.name, (ret) => {
                    tfCmdHandler(ret, complete, "Failed to unshelve shelveset: "+ shelveSet);
                });
            } else {
                // nothing to unshelve
                complete(null);
            }
        }
    ],
    function(err) {
       asyncHandler(err, callback);
    });
}
