var express = require('express'),
    swig = require('swig'),
    io = require('socket.io'),
    http = require('http'),
    jsdom = require('jsdom'),
    redisLib = require('redis'),
    redis = new redisLib.createClient();

// create and configure express app
var app = express.createServer(),
    server = http.createServer(app),
    io = require('socket.io').listen(server);

server.listen(1337);
console.log('Server running at http://127.0.0.1:1337/');

// create and configure express app
app.configure(function() {
    swig.init({
        root: __dirname + '/views',
        allowErrors: true // allows errors to be thrown and caught by express
    });
    app.engine('.html', require('consolidate').swig);
    // app.set('views', __dirname + '/views');
    app.set('view engine', 'html');
    app.set('view options', { layout: false });
    app.use(express.bodyParser());
    app.use(express.static(__dirname + '/public'));
    app.use(app.router);
    // app.use(express.cookieParser());
    // app.use(express.session({store: sesh, secret: config.redis_secret}));
    // app.use(everyauth.middleware()); // pretend you didn't see this yet
});

//set routes
app.get('/',function(req, res) {
    res.render('home');
});
app.get('/calls',function(req, res) {
    res.render('client');
});
app.get('/wiki',function(req, res) {
    getWikiTrends(res, function(trends) {
        if (trends && trends.result) {
            res.render('trends', {trends: trends.trends});
        } else {
            res.render('error', {error: trends.error});
        }
    });
});
app.get('/wiki/:title?/:extra?', function(req, res) {
    getWikiArticle(res, req.params.title, function(article) {
        if (article && article.result) {
            res.render('article', article);
        } else {
            res.render('error', {error: article.error});
        }
    });
});


/* 
 * WIKI APP
 */
function getWikiArticle(response, title, cb) {
    title = title ? encodeURIComponent(title) : 'Pearm_Jam';
    console.log("Getting Wiki article: " + title);
    getFromCache(title, function(cacheResponse) {
        // console.log('cacheResponse: ', cacheResponse);
        incrementArticleViews(title);

        if (cacheResponse.result) {
            console.log("Got article from cache");
            cb(cacheResponse);
        } else {
            // check for special case pages
            var sections = '&section=0';
            if (title.endsWith('(disambiguation)')) {
                sections = '';
            }
            var opts = {
                host: "en.wikipedia.org",
                path: '/w/api.php?format=json&action=parse' + sections + '&page=' + title,
                headers : {
                    'user-agent': 'myTestWikiBot/0.1'
                },
                method: "GET"
            };
            console.log('WikiAPI: Making request ' + opts.host + opts.path);
            var result = { result: false, error: '', title: title, article: '' };
            var apiRequest = http.request(opts, function(apiResp) {
                var data = "";
                apiResp.setEncoding('utf8');
                apiResp.on('data', function (chunk) {
                    data += chunk;
                });
                apiResp.on('end', function () {
                    data = JSON.parse(data);
                    if (data.error) {
                        result.error = data.error.info;
                        console.log("WikiAPI: " + result.error)
                        cb(result);
                    } else if (data.parse && data.parse.text) {
                        html = data.parse.text['*'];
                        // use jsdom to parse html and remove unwanted elements with jQuery
                        jsdom.env(html, [
                            // 'http://code.jquery.com/jquery-1.5.min.js'
                            __dirname + '/public/js/libs/jquery-1.7.2.min.js'
                        ],
                        function(errors, window) {
                            // check for elements to remove/unwrap
                            var elementsToRemove = [
                                'table', //all tables?
                                // 'table.infobox',
                                // 'table.metadata',
                                // 'table.toc',
                                // 'table.vertical-navbox',
                                'a.Listen',
                                'sup.reference',
                                'sup.noexerpt',
                                'strong.error',
                                'div.dablink',
                                'div.thumbcaption',
                                'span.editsection',
                                'img:gt(1)' // all images except first one
                            ];
                            var elementsToUnwrap = [
                                'a.image > img.thumbimage'
                            ];
                            var elementsToDelink = [
                                'a.new'
                            ];
                            console.log('Removing from article: ' + elementsToRemove.join());
                            window.$(elementsToUnwrap.join()).unwrap();
                            window.$(elementsToRemove.join()).remove();
                            window.$(elementsToDelink.join()).each(function() {
                                window.$(this).replaceWith(window.$(this).text());
                            });
                            result.result = true;
                            result.article = window.$("body").html();
                            console.log("WikiAPI: Got article.")
                            addToCache(title, result.article);
                            cb(result);
                        });
                    } else {
                        result.error = 'Unknow error.';
                        console.log('WikiAPI: ' + result.error);
                        cb(result);
                    }
                });
            });
            apiRequest.on('error', function(e) {
                result.error = 'Request failed.';
                console.log('WikiAPI: ' + result.error + ' ' + e.message);
                cb(result);
            });
            apiRequest.end();
        }
    });
}

function getWikiTrends(response, cb) {
    console.log("Getting Wiki trends");
    getFromCache('__trends__', function(cacheResponse) {
        // console.log('cacheResponse: ', cacheResponse);
        if (cacheResponse.result) {
            console.log("Got Wiki trends from cache");
            cacheResponse.trends = JSON.parse(cacheResponse.article);
            cb(cacheResponse);
        } else {
            // check for special case pages
            var opts = {
                host: "www.trendingtopics.org",
                path: '/pages.xml?page=1',
                headers : {
                    'user-agent': 'myTestWikiBot/0.1'
                },
                method: "GET"
            };
            console.log('WikiTrends: Making request ' + opts.host + opts.path);
            var result = { result: false, error: '', trends: [] };
            var apiRequest = http.request(opts, function(apiResp) {
                var data = "";
                apiResp.setEncoding('utf8');
                apiResp.on('data', function (chunk) {
                    data += chunk;
                });
                apiResp.on('end', function () {
                    // data = JSON.parse(data);
                    if (data) {
                        // use jsdom to parse xml
                        jsdom.env(data, [
                            __dirname + '/public/js/libs/jquery-1.7.2.min.js'
                        ],
                        function(errors, window) {
                            window.$('pages > page').each(function(index) {
                                result.trends.push({
                                    'total-pageviews': window.$(this).find('total-pageviews').text(),
                                    url: window.$(this).find('url').text(),
                                    title: window.$(this).find('title').text()
                                });
                            });
                            result.result = true;
                            console.log("WikiTrends: Got trends.")
                            addToCache('__trends__', JSON.stringify(result.trends), 3600*4);
                            cb(result);
                        });
                    } else {
                        result.error = 'Unknow error.';
                        console.log('WikiTrends: ' + result.error);
                        cb(result);
                    }
                });
            });
            apiRequest.on('error', function(e) {
                result.error = 'Request failed.';
                console.log('WikiTrends: ' + result.error + ' ' + e.message);
                cb(result);
            });
            apiRequest.end();
        }
    });
}

function addToCache(title, article, expire) {
    if(typeof(expire)==='undefined') a = 604800;

    console.log("Cache: adding " + title + " for " + expire + "s");
    redis.set('article:'+title, article);
    redis.expire('article:'+title, expire);
}

function getFromCache(title, cb) {
    console.log('Cache: checking for ' + title);
    redis.get('article:'+title, function(err, reply) {
        cb({result: reply != null, error: '', article: reply, title: title});
    });
}

function incrementArticleViews(title) {
    console.log('Redis: incrementing article count for ' + title);
    redis.zincrby('articles', 1, 'article:'+title);
}


if (typeof String.prototype.endsWith != 'function') {
    String.prototype.endsWith = function (str){
        return this.indexOf(str,this.length-str.length) === this.length-str.length;
    };
}

/* 
 * WEBSOCKET APP
 */

// Set up sockets
var usernames = {};
var calls = {};
io.sockets.on('connection', function (socket) {
    // when the client emits 'sendchat', this listens and executes
    socket.on('sendchat', function (data) {
        // we tell the client to execute 'updatechat' with 2 parameters
        io.sockets.emit('updatechat', socket.username, data);
    });

    // when the client emits 'adduser', this listens and executes
    socket.on('adduser', function(username){
        // we store the username in the socket session for this client
        socket.username = username;
        // add the client's username to the global list
        usernames[username] = username;
        // echo to client they've connected
        socket.emit('updatechat', 'SERVER', 'you have connected');
        // echo globally (all clients) that a person has connected
        socket.broadcast.emit('updatechat', 'SERVER', username + ' has connected');
        // update the list of users in chat, client-side
        io.sockets.emit('updateusers', usernames);

        setTimeout(function() {
            generatCall(socket);
        }, 5000);
    });

    socket.on('answercall', function() {
        io.sockets.emit('updatechat', 'SERVER', socket.username + ' has answered a call from ' + socket.number);
        calls[socket.number]['answered'] = new Date();
        // calls[socket.number]['operator'] = socket.username;
        io.sockets.emit('updatecalllog', calls);
    });

    socket.on('endcall', function() {
        // io.sockets.emit('updatechat', 'SERVER', socket.username + ' has answered a call from ' + socket.number);
        calls[socket.number]['end'] = new Date();
        io.sockets.emit('updatecalllog', calls);

        setTimeout(function() {
            generatCall(socket);
        }, 10000);
    });

    function generatCall(socket) {
        socket.number = '08' + Math.floor((Math.random()+2)*10000000);
        calls[socket.number] = {
            operator: socket.username,
            start: new Date(),
            answered: '',
            end: ''
        };
        socket.emit('incomingcall', socket.number);
        socket.emit('updatecalllog', calls);
    }

    // when the user disconnects.. perform this
    socket.on('disconnect', function(){
        // remove the username from global usernames list
        delete usernames[socket.username];
        // update list of users in chat, client-side
        io.sockets.emit('updateusers', usernames);
        // echo globally that this client has left
        socket.broadcast.emit('updatechat', 'SERVER', socket.username + ' has disconnected');
    });
});