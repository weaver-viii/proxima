"use strict";

var core = require('jscore');
var net = require('net');
var constants = require('./Constants.js');
var SNI = require('./SNI.js');
var HTTP = require('./HTTP.js');
var Proxy = require('./Proxy.js');
var endpoint = require('./endpoint.js');

var Server = module.exports = core.Class.extend(core.fn.overload(
{
	args: { type: "object", optional: true },
	call: function(options)
	{
		options = options || {};
		if (options.specTimeout != null)
			this._speculativeTimeout = core.type.coerce.integer(options.specTimeout, 0);

		core.sub.evented(this);

		this._servers = [];
		this._routes = [];
		this._proxies = [];
	}
}))
.implement({
	_speculativeTimeout: 1000,
	_clientIndex: 0,
	_404: true,
	_500: true,
	_504: true,
	listen: core.fn.overload(
	{
		// TCP/IP
		args: [
			"number",
			{ type: "string", optional: true },
			{ type: "boolean", optional: true, _: false },
			{ type: "number", optional: true }
		],

		call: function(port, host, secure, backlog)
		{
			var args = [port];
			if (!host)
				args.push(host);
			if (backlog != null)
				args.push(backlog);

			return this._listen(secure, args);
		}
	},
	{
		// Unix Socket Path OR Existing Socket
		args: [
			["string", "object"],
			{ type: "boolean", optional: true, _: false }
		],
		call: function(path, secure)
		{
			return this._listen(secure, [path]);
		}
	}),
	addRoute: core.fn.overload(
	{
		args: [
			["string", "regex"],
			"object"
		],
		call: function(hostname, options)
		{
			this._addRoute(hostname, options);

			return this;
		}
	},
	{
		args: [
			["string", "regex"],
			"number",
			{ type: "string", optional: true },
			{ type: "boolean", optional: true, _: false }
		],
		call: function(hostname, port, host, secure)
		{
			this._addRoute(hostname, {
				port: port,
				host: host,
				secure: secure
			});

			return this;
		}
	},
	{
		args: [
			["string", "regex"],
			"string",
			{ type: "boolean", optional: true, _: false }
		],
		call: function(hostname, path, secure)
		{
			this._addRoute(hostname, {
				path: path,
				secure: secure
			});
		}
	}),
	removeRoute: core.fn.overload(
	{
		args: [
			["string", "regex"]
		],
		call: function(hostname)
		{
			var i = this._routes.length;

			while (i--)
			{
				if (this._routes[i].hostname === hostname)
				{
					this._routes.splice(i, 1);
					break;
				}
			}

			return this;
		}
	}),
	set404: core.fn.overload(
	{
		args: [['boolean', "number", "string", "function", "object"]],
		call: function(value)
		{
			this._404 = (typeof value !== 'boolean' && !(value instanceof Function)) ? endpoint.normalize(value) : value;
			return this;
		}
	}),
	set500: core.fn.overload(
	{
		args: [['boolean', "number", "string", "function", "object"]],
		call: function(value)
		{
			this._500 = (typeof value !== 'boolean' && !(value instanceof Function)) ? endpoint.normalize(value) : value;
			return this;
		}
	}),
	set504: core.fn.overload(
	{
		args: [['boolean', "number", "string", "function", "object"]],
		call: function(value)
		{
			this._504 = (typeof value !== 'boolean' && !(value instanceof Function)) ? endpoint.normalize(value) : value;
			return this;
		}
	}),
	openConnections: function()
	{
		return this._proxies.length;
	},
	close: function()
	{
		var i = this._servers.length;
		while (i--)
			this._servers[i].close();

		return this;
	},
	_listen: function(secure, args)
	{
		var server = net.createServer({ allowHalfOpen: true });

		server
			.on('listening', this._onListening.bind(this, server))
			.on('connection', this._onConnection.bind(this, server))
			.on('close', this._onClose.bind(this, server))
			.on('error', this._onError.bind(this, server));

		server.secure = secure;
		server.listen.apply(server, args);

		this._servers.push(server);

		return this;
	},
	_addRoute: function(hostname, options)
	{
		this._routes.push({
			hostname: hostname,
			rx: typeof hostname === 'string' ? this._globToRegex(hostname) : hostname,
			secure: !!options.secure,
			upstream: endpoint.normalize(options)
		});
	},
	_globToRegex: function(glob)
	{
		return new RegExp(glob
			.replace(/[\^\-\[\]\s\\{}()+.,$|#]/g, "\\$&")
			.replace(/\*/g, '.*')
			.replace(/\?/g, '[^.:]*')
		);
	},
	_onListening: function(server)
	{
		core.fn.safe( this, 'emit', 'listening', server);
	},
	_onConnection: function(server, client)
	{
		client.index = ++this._clientIndex;
		client.secure = !!server.secure;
		client.routeErrors = {};

		this._timeout(client);

		client.once('data', this._onData.bind(this, server, client));

		core.fn.safe( this, 'emit', 'connection', client, server);
	},
	_onData: function(server, client, firstPacket)
	{
		var hostname = '';

		try
		{
			if (client.secure)
				hostname = SNI.parse(firstPacket);
			else
				hostname = HTTP.parse(firstPacket);
		}
		catch (err)
		{
			if (!(err instanceof SNI.NotPresent) && !(err instanceof HTTP.MissingHostHeader))
			{
				core.fn.safe(client, 'emit', 'warning', err.message ? err.message : err);
				client.destroy();

				return;
			}
		}

		core.fn.safe(client, 'emit', 'hostname', hostname);

		var upstream = this._resolveRoute(hostname, client.secure);

		if (!upstream)
		{
			core.fn.safe(client, 'emit', 'warning', '404 Hostname Not Found');

			if (!this._on404(server, client, firstPacket))
				client.destroy();
		}
		else
		{
			this._proxy(server, client, firstPacket, upstream);
		}
	},
	_onProxy: function(proxy, connectArgs)
	{
		core.fn.safe( this, 'emit', 'proxy', proxy, connectArgs);
	},
	_onClose: function(server)
	{
		core.fn.safe( this, 'emit', 'close', server);
	},
	_onError: function(server, err)
	{
		core.fn.safe( this, 'emit', 'error', err, server);
	},
	_timeout: function(client)
	{
		// Some browsers make speculative connections which they never end up
		// using. This timeout will destroy these extra connections if they are
		// not used within one second.

		if (!this._speculativeTimeout)
			return;

		var timeout = setTimeout(function()
		{
			core.fn.safe(client, 'emit', 'warning', 'no data received (speculative timeout)');
			client.destroy();
		}, this._speculativeTimeout);

		client.once('data', function()
		{
			clearTimeout(timeout);
		});
	},
	_proxy: function(server, client, firstPacket, upstream)
	{
		var proxy = Proxy.create(server, client);

		this._proxies.push(proxy);

		proxy
			.on('close', function()
			{
				var i = this._proxies.length;
				while (i--)
				{
					if (this._proxies[i] === proxy)
					{
						this._proxies.splice(i, 1);
						break;
					}
				}
			}.bind(this))
			.on('error', function()
			{
				core.fn.safe(client, 'emit', 'warning', '504 No Upstream Response');

				if (!this._on504(server, client, firstPacket))
					client.destroy();
			}.bind(this));

		this._onProxy(proxy, upstream.slice(0));

		try
		{
			proxy.connect.apply(proxy, upstream.concat([firstPacket]));
		}
		catch (err)
		{
			core.fn.safe(client, 'emit', 'warning', '500 Invalid Upstream Configuration');

			if (!this._on500(server, client, firstPacket))
				client.destroy();

			this._onError(null, err);
		}
	},
	_resolveRoute: function(hostname, secure)
	{
		var i = this._routes.length;

		while (i--)
		{
			if (this._routes[i].secure === secure && this._routes[i].rx.test(hostname))
				return this._routes[i].upstream;
		}

		return false;
	},
	_on404: function(server, client, firstPacket)
	{
		if (client.routeErrors['404'])
			return false;
		else
			client.routeErrors['404'] = true;

		if (client.secure || this._404 === false)
			return false;
		else if (this._404 === true)
			client.end(constants.responseNoRoute, 'utf8');
		else if (this._404 instanceof Function)
			this._404(server, client, firstPacket);
		else
			this._proxy(server, client, firstPacket, this._404, true);

		return true;
	},
	_on500: function(server, client, firstPacket)
	{
		if (client.routeErrors['500'])
			return false;
		else
			client.routeErrors['500'] = true;

		if (client.secure || this._500 === false)
			return false;
		else if (this._500 === true)
			client.end(constants.responseUpstreamInvalid, 'utf8');
		else if (this._500 instanceof Function)
			this._500(server, client, firstPacket);
		else
			this._proxy(server, client, firstPacket, this._500, true);

		return true;
	},
	_on504: function(server, client, firstPacket)
	{
		if (client.routeErrors['504'])
			return false;
		else
			client.routeErrors['504'] = true;

		if (client.secure || this._504 === false)
			return false;
		else if (this._504 === true)
			client.end(constants.responseUpstreamError, 'utf8');
		else if (this._504 instanceof Function)
			this._504(server, client, firstPacket);
		else
			this._proxy(server, client, firstPacket, this._504, true);

		return true;
	}
});

core.util.readonly(Server, { version: constants.package.version });
