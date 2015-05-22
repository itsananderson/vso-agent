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

var shellCmdExecutor = function (ctx, cmd, args: string[], callback) {
    var quotedArg = function(arg) {
        var quote = '"';
        if (arg.indexOf('"') > -1) {
            quote = '\'';
        }
        return quote + arg + quote;
    }
        
    var getQuotedArgs = function (arguments) {
         return arguments.map((a) => quotedArg(a));
    }    
    
    var getCmdline = function(cmd, arguments) {
        return 'tf ' + cmd + ' ' + getQuotedArgs(arguments).join(' ');
    };
    
    utilm
       .exec(getCmdline(cmd, args))
       .done(function (ret) {
           callback(ret); 
       });
} 

var ctxSpwanExecutor = function (ctx, cmd, args: string[], callback) {
    /* hide running cmd since it contains login info */
    var options = {
        showRunningCmd: false
    }
    
    ctx.util.spawn('tf', [cmd].concat(args), options, (err, code) => { 
        var status =  (code === 0) ? ' succeeded' : ' failed'         
        var output = (err) ? err.name : 'tf ' + cmd + status;
        callback({code: code, output: output});
    });
}

function _tfCmdExecutor(ctx, options, cmdRunner: (ctx, cmd, args: string[], callback) => any) {
    return function(cmd, args, callback) {
        var collectionArg = '-collection:' + options.collectionUri;
        var loginArg = '-login:' + options.creds.username + ',' + options.creds.password; 
        
        var arguments = args.concat([collectionArg, loginArg]);
        var maskedArguments = args.concat([collectionArg, '-login:********']);
        
        ctx.info('[command]tf ' + cmd + ' ' + maskedArguments.join(' '));
        
        cmdRunner(ctx, cmd, arguments, callback);
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
    tfCmdExecutor('workspaces', ['-format:xml'], (ret) => {
        var workspace = null;

        if (success(ret) && ret.output) {
            xr.read(ret.output, (err, res) => {
                res.workspaces.workspace.each((i, ws) => { 
                    if (ws.attributes()['name'] === workspaceName) {
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
    tfCmdExecutor("workspace", ['-new', '-permission:Public', '-location:server', workspace], callback);
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
    tfCmdExecutor('unshelve', ['-recursive', '-format:detailed', '-workspace:' + workspace, shelveset], callback);
}

function _undo(tfCmdExecutor, callback) {
    tfCmdExecutor('undo', ['-recursive', '.'], callback);
}

export function getcode(ctx, options, callback) {
    ctx.verbose('cwd: ' + process.cwd());
    var tf = shell.which('tf');
    if (!tf) {
        var msg = "Failed to invoke the Microsoft Team Explorer Everywhere 'tf' command.";
        ctx.error("'tf' was not found. Please install the Microsoft Team Explorer Everywhere cross-platorm, command-line client and add 'tf' to the path.");
        ctx.error("Please also accept its End User License Agreement by running 'tf eula'.");
        ctx.error("See https://www.visualstudio.com/products/team-explorer-everywhere-vs.aspx");
        callback(msg);
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
    var workspaceName = options.workspace;
    var mappings = options.mappings;
    var changeSetVersion = options.version;
    var shelveSet = options.shelveset;
    
    // used to run short cmds and pipes the command stdout back, this is required for parsing workspaces
    var tfShortCmdExecutor = _tfCmdExecutor(ctx, options, shellCmdExecutor);
    
    // used to run long running cmds and don't care about stdout, pipe stdout to console directly.
    // also any nonzero return code from those cmds may fail the job
    var tfLongCmdExecutor = _tfCmdExecutor(ctx, options, ctxSpwanExecutor);

    async.series([
        // get existing workspace
        function (complete) {
            ctx.section('Setup workspace');
            _getWorkspace(tfShortCmdExecutor, workspaceName, (ws) => {
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

                        _deleteWorkspace(tfShortCmdExecutor, workspaceName, (ret) => {
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

            _newWorkspace(tfShortCmdExecutor, workspaceName, (ret) => {
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
                _decloakFolder(tfShortCmdExecutor, cloak.serverPath, workspace.name, (ret) => {
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
                _unmapFolder(tfShortCmdExecutor, map.serverPath, workspace.name, (ret) => {
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
                            _mapFolder(tfShortCmdExecutor, mapping['serverPath'], localPath, workspace.name, (ret) => {
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
                    _cloakFolder(tfShortCmdExecutor, mapping['serverPath'], workspace.name, (ret) => {
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
                _undo(tfShortCmdExecutor, (ret) => {
                    // ignore return code, as the return is not 0 when there is nothing to undo
                    if (success(ret)) {
                        ctx.info(ret.output);
                    }

                    _get(tfLongCmdExecutor, changeSetVersion, (ret) => {
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
                _unshelve(tfLongCmdExecutor, shelveSet, workspace.name, (ret) => {
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
