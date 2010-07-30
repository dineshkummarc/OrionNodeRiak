var http = require('http'), 
		url = require('url'),
		fs = require('fs'),
		//socketIoServer = require('./socket-io-server/lib/socket.io'),
		sys = require('sys'),
      send404 = function(res){
	      res.writeHead(404);
	      res.write('404');
	      res.end();
      };

if(!global.SC) require('./sc/runtime/core');

require('./OrionFileAuth');
require('./OrionSession');
require('./OrionSocketListener');
/*
The idea behind this Node.js OrionServer is to have a node-js server
that is reached using a apache proxy to overcome same-origin-policy trouble

The way requests are handled is more or less the same as a normal REST interface,
that is that the websocket connection uses a format that is comparable to the http requests:

{"get":"model/id"}
{"post":"model"}
{"put":"model/id"}
{"delete":"model/id"}


*/
global.OrionServer = SC.Object.extend({
   models: [], // an array of model objects
   
   port: 8080,
   
   allowWebSocket: true,
   
   forceAuth: true, // the socket clients haven't been written in such a way atm that changing this to false does anything...
   
   forceMD5Auth: false,
   
   authModule: null,
   
   sessionModule: OrionSession.create({ sessionName: 'OrionServerTest' }),
   
   store: null, // place to bind the store / data source to
   
   createHTTPHandler: function(serverObj){
      return function(request, response){
         var path = url.parse(request.url).pathname;
         var method = request.method;
         if(path === '/'){
            //send404(response);
            response.writeHead(200, {'Content-Type': 'text/html'});
            response.write("request URL: " + request.url + "<br>");
            response.write("request path: " + path + "<br>");
            response.end();
         }
         else {
            if(serverObj.forceAuth){ 
               var resource = path.slice(1);
               // make sure that the user is authenticated, 
               // but only after we found out the current request doesn't turn out to be an auth request
               if(method === 'POST' && resource == 'auth'){ // force auth with posting
                  var authdata = "";
                  request.addListener("data", function(chunk){ // gather data
                     authdata += chunk;
                  });
                  request.addListener("end", function(){ // finished gathering data, call AUTH
                     serverObj.AUTH(request,authdata,response);
                  });
               }
               else { // if not an auth request, check whether the user has a session
                  //sys.puts(sys.inspect(request));
                  var receivedCookieHeader = request.headers['cookie'];
                  var receivedUserName = request.headers['username'];
                  sys.puts('cookieHeader received: ' + receivedCookieHeader);
                  if(receivedCookieHeader && receivedUserName){
                     //check the session
                     var hasSession = serverObj.sessionModule.checkSession(receivedUserName,receivedCookieHeader);
                     if(!hasSession){
                        response.writeHead(403, {'Content-Type':'text/html'});
                        response.write('Not logged in, invalid cookie'); // this can be much more fancy of course!
                        response.end();                        
                        return;
                     } // do nothing else, let flow continue to the switch(method) below
                  }
                  else {
                     response.writeHead(403, {'Content-Type':'text/html'});
                     response.write('Not logged in, no cookie information found'); // this can be much more fancy of course!
                     response.end(); 
                     return;
                  }
               }
            }
            switch(method){
               case 'GET': serverObj.GET(request,response); break;
               case 'POST': 
                  var postdata = "";
                  request.addListener("data", function(chunk){ // gather data
                     postdata += chunk;
                  });
                  request.addListener("end", function(){ // finished gathering, call post
                     serverObj.POST(request,postdata,response);
                  });
                  break;
               case 'PUT':
                  var putdata = "";
                  request.addListener("data", function(chunk){ //gather data
                     putdata += chunk;
                  });
                  request.addListener("end", function(){
                     serverObj.PUT(request,putdata,response); // finish gathering, call put
                  });
                  break;
               case 'DELETE': 
                  var deletedata = "";
                  request.addListener("data", function(chunk){ //gather data
                     deletedata += chunk;
                  });
                  request.addListener("end", function(){
                     serverObj.DELETE(request,deletedata,response); // finish gathering, call delete
                  });
                  break;  
            }               
         }
      };
   },
      
   createFetchCallback: function(request,response){
     // create a callback function that is able to write stuff back to the 
     // original http request
     // for now this function is intended to be used for the extended getAll function
     // needs either expansion or additional functions  
     return function(data){
        if(data){
           // for now: write the data to response
           response.writeHead(200, {'Content-Type': 'text/html'});
           //response.write(" numrecords: " + numrecords);
           response.write(JSON.stringify(data));
           response.end();           
        }
        else {
           // for now: write the data to response
           response.writeHead(200, {'Content-Type': 'text/html'}); 
           response.write("Riak error callback. <br>");
           response.write("data in Riak response: " + data + "<br/>");
           response.write("data in Riak response per key: <br>" );
           for(var key in data){
              response.write("Key: " + key + " value: " + data[key] + "<br>");
           }
           response.end();           
        }
     };
   },
   
   AUTH: function(request,data,response){
      // when succesfully authenticated, send back a set-cookie header
      // a standard PHP session start answers with the following headers on the auth request
      /* 
      Date	Fri, 02 Jul 2010 20:14:48 GMT
      Server	Apache
      Expires	Thu, 19 Nov 1981 08:52:00 GMT
      Cache-Control	no-store, no-cache, must-revalidate, post-check=0, pre-check=0
      Pragma	no-cache
      Set-Cookie	Orion_loginproto=teacher; expires=Mon, 02-Aug-2010 20:14:48 GMT
      Vary	Accept-Encoding
      Content-Encoding	gzip
      Content-Length	661
      Keep-Alive	timeout=15, max=200
      Connection	Keep-Alive
      Content-Type	text/html
      */
     
      var givenCookieHeader = request.headers.Cookie;
      //response.write('received data: ' + data);
      // data should be json stuff
      var dataObj = JSON.parse(data);
      var authResult = this.authModule.checkAuth(dataObj.user, dataObj.passwd,false);
      if(authResult){
         // successfull auth
         var newCookieHeader = this.sessionModule.createSession(dataObj.user);
         response.writeHead(200, {'Content-Type': 'text/html', 'Set-Cookie':newCookieHeader });
      }
      response.write("<br/>auth result: " + authResult);
      response.write('<br/>received cookie: ' + givenCookieHeader);
      response.end();      
      
   },
   
   GET: function(request,response){
      var me = this;
      var path = url.parse(request.url).pathname;
      var resource = path.slice(1); // return the entire string except the first character (being a "/")
      // for the moment don't parse the resource, but just assume it is the model name
      this.store.fetch(resource,"student/1",this.createFetchCallback(request,response));     
   },
   
   POST: function(request,data,response){
      //response.writeHead(200, {'Content-Type': 'text/html'});
      //response.write("request URL: " + request.url + "<br>");
      //response.write("request path: " + path + "<br>");
      //sys.puts(sys.inspect(request));
      response.writeHead(200, {'Content-Type': 'text/html'});
      response.write('received data: ' + data);
      response.end();
   },
   
   handlePUT: function(request,data,response){
      
   },
   
   handleDELETE: function(request,data,response){
      
   },
   
   socketIO: null,
   
   socketIOBuffer: [],
   
   _modelCache: [],
   
   _loadModels: function(){
      var models = this.models;
      var me = this;
      models.forEach(function(v){
         if(v.isClass){
            var resource = v.prototype.resource? v.prototype.resource: v.prototype.bucket;
            if(resource){
               me._modelCache[resource] = v;  
            }
         }
      });
      //sys.puts('modelCache: ' + sys.inspect(this._modelCache));
   },
   
   server: null,
         
   _startServer: function(){
      this.server = http.createServer(this.createHTTPHandler(this));
      this.server.listen(this.port);
   },
   
   /*
      there are a few there common functions every activity should call in case the websocket is enabled...
      this has to do with the nature of a websocket connection...
      
      - the server should keep a memory of what data actually has been written to the different clients
        to be able to update clients with older versions of those records...
        something like an array of { bucket: '', id: '', timestamp: ''}
        Of course it could be interesting to send all updates to all clients, but that would result
        in loads of traffic, especially of all kinds of data some clients don't even should have access to...
        By keeping the data just to already requested records, no-one gets information he or she doesn't deserve
      
      - in addition to the records the user requested the server should check whether new records fit fetch 
        request conditions of the past, preventing users to get records they don't need to get and to
        be able to send records they should get (SC.Query??)
        YES: SCQuery!!! 
        using it is actually very, very easy. 
        var query = SC.Query.create({
            conditions: "userid = {user}",
            parameters: { user: 1}
        });
        query.parse();
        
        now we can do record matching by calling query.contains(record);
        it returns YES on match, and NO when there is no match
        
        
      - in addition the server should check on permissions, that is whether the user actually has read permission 
        on the record that has been changed/deleted/created
        
   */
   
   _attachWebSocket: function(){
      var json = JSON.stringify;
      var me = this;
      //this.socketIO = socketIoServer.listen(this.server, {
      //sys.puts("server before socketio init: " + this.server);
      
      // first create because we need to able to refer to it later
      // I had create().start() but that didn't return the socketlistenerobject ... oops ...
      this.socketIO = OrionSocketListener.create({OrionServer: this }); 
      this.socketIO.start(this.server,{
      	onClientConnect: function(client){
      	   //sys.puts("onClientConnect in OrionServer called");
      	   // no particular action needed here...
      	},

      	onClientDisconnect: function(client){
      	   //sys.puts("onClientDisconnect in OrionServer called");
      	   // client disconnects, probably also no action needed here...
      	},

      	onClientMessage: function(message, client){
      	   sys.puts("onClientMessage in OrionServer called");
      	   if(message.fetch) me.onFetch.call(me,message,client,function(data){ client.send(data);});
      	   if(message.refreshRecord) me.onRefresh.call(me,message,client,function(data) {client.send(data);});
      	   if(message.createRecord) me.onCreate.call(me,message,client,function(data){ client.send(data);});
      	   if(message.updateRecord) me.onUpdate.call(me,message,client,function(data){ client.send(data);});
      	   if(message.deleteRecord) me.onDelete.call(me,message,client,function(data){ client.send(data);});
      	}
      	
      });
      //sys.puts("When attaching the socketIO server, this refers to " + sys.inspect(this));
   },
   
   start: function(){
      sys.puts('Starting OrionServer');
      // load the models, push the resource names inside the model cache
      // commented out as they are not used atm
      //this._loadModels();
      //sys.puts('DB Models loaded...');
      this._startServer();
      // start the server

      if(this.allowWebSocket){
         this._attachWebSocket();
      }     
   },

   /*
   DATA requests:
   { refreshRecord: { bucket: '', key: '', returnData: {} }} 
   { fetch: { bucket: '', conditions: '', parameters: {}, returnData: {} }}
   { createRecord: { bucket: '', record: {}, returnData: {} }}
   { updateRecord: { bucket: '', key: '', record: {}, returnData: {} }}
   { deleteRecord: { bucket: '', key: '', returnData: {} }}
   
   // the fetch call has the option of passing the conditions and parameters of a query
   // records will be filtered based on it
   
   // most properties are self explanatory, but returnData needs some explanation on its own.
   // return data is an object that can be delivered along side the request and which is
   // returned by the server in the answer to that request. This helps the client side identifying 
   // what request was answered exactly.
   
   // returned by the server as answer to a client request
   { fetchResult: { bucket: '', records: [], returnData: {} }}
   { createRecordResult: { bucket: '', key: '', record: {}, returnData: {} } }
   { updateRecordResult: { bucket: '', key: '', record: {}, returnData: {} } }
   { deleteRecordResult: {}, returnData: {} }
   { refreshRecordResult: { bucket: '', key: '', record: {}, returnData: {} } }
   */


   
   /*
   
   Message handling: these functions should be more or less the same for both REST and websocket
   interfaces... That is, a rest update should be forwarded to all connected websocket clients
   That means that the onFetch method doesn't speak to the client itself, but should only 
   return the data from the db request
   
   it may actually be a nice idea to only have this function called as a callback after 
   a call. We don't have to deal with relations anyway, so we don't need to do pre-dbcall checks
   The only thing is that in order to update session data about queries etc we need access to the
   original request, which is very easy to do...
   
   While using this kind of function as fetch, there is no problem with pre-db checks,
   but if we want to be able to o pre-db checks like model-value record validation
   this scheme wouldn't work
   
   what if the request is pushed to the onFetch with a callback function to call at the end of the 
   run? That seems to be a better idea...
   
   the callback only needs to be called with one parameter, being the data to send
   
   The handlers need to return the data in the proper format, as described above.
   The handlers also need to check for connections on socketio.
   
   Hmm, that last idea just feels wrong... actually, you would rather have a separate function do the 
   socket io checking..., even all listeners checking
   that function should ask all listeners what clients (authenticatedClients) they have and what session 
   ids they have
   Then we can get to the session data cache, ask it whether the present record fits the past of the client,
   and if yes, go back to the listener, check whether a connection exists (or even do if before checking the
   session data) and send it when a connection exists, or push it to the data cache
   
   There is one issue yet to be solved and that is that the current checking only returns yes or no,
   but not what kind of action would be appropriate... 
   
   I just realised that by choosing the data calls as I did I almost forced the server into having to know
   what kind of action the client should perform on the data... especially the create vs update seems
   It seems to be wiser to have that decision made by the client whether a record is created or updated..
   Deletion though should be marked clearly.
   On the other side, the server already knows what records the client has.
   So, let's have the answer by the server cache decide what needs to happen with
   
   The start of the flow should most definitely be here... There is only the question of the case
   in which multiple types of client need to be kept up to date... The best seems to be an array
   of listener objects which need to be checked...
   
   */


   /*
      While working on the data source it turns out that doing all the relations on the client side makes things very 
      complicated. Still it feels wrong to have to define models in two different places. 
      So the idea now is to send a relation graph from the client to the server to have the server reply in a few different messages
      Of course it is not a complete relation graph, but just a relation graph of a specific model
      
      The fetch request becomes something like this:
      
      { fetch: { bucket: '', conditions:'', parameters: '', 
                  relations: [ { propertyName: '', type: 'toOne', bucket: ''}, { propertyName: '', type: 'toMany', bucket: ''}]}}
      
      From this data the server can create a set of messages to be sent to the client
      The client can know beforehand how many messages to receive (one for the main record data, and one for each relation)
      
      the answer of the server will be:
      
      - a normal fetchResult
      - { fetchResult: { relationSet: [ { bucket: '', keys: [''], propertyName: '', data: {} } ], returnData: { requestKey: ''}}} 
         where:
            - bucket is the bucket the request belongs to
            - keys is the set of keys for which the relation data is contained in data
            - propertyname is the name of the toOne or toMany property
            - data is the set of keys describing the relation, associative array by key
            - requestKey is the key of the original request
         
      It could turn out to be very useful if the set of storeKeys are stored in the data source as it would speed up 
      processing of the relation data
      
      We need to think about a way to generate the junction table fields, something like [bucketname,"key"].join("_")
      We also need a way to name the junction bucket/table, the best option seems to be the combination of both bucket names
      in alphabetised order. 
   */
   

   onFetch: function(message,client,callback){
      // the onFetch function is called to do the back end call and return the data
      // as there is no change in the data, the only thing it needs to do versus
      // the server cache is to update the server cache with the records the current
      // client / sessionKey combination requested.
      // this function uses a callback to return the result of the fetch so the function can
      // be used as you would like...
      /*
      the storeRequest is an object with the following layout:
      { bucket: '', 
        key: '', // not used by fetch
        conditions: '', // not used by the individual record functions (create,refresh,update,delete)
        parameters: {}, // not used by the individual record functions (create,refresh,update,delete)
        relations: [ 
           { bucket: '', type: 'toOne', propertyName: '' }, 
           { bucket: '', type: 'toMany', propertyName: ''} 
        ] 
      } */
               
      var fetchinfo = message.fetch; 
      var me = this;
      var clientId = [client.user,client.sessionKey].join("_");
      var storeRequest = { 
         bucket: fetchinfo.bucket, 
         conditions: fetchinfo.conditions, 
         parameters: fetchinfo.parameters,
         relations: fetchinfo.relations 
      };
      me.store.fetch(storeRequest,clientId,function(data){ 
         /*
         The functionality of this callback function is going to change quite a bit... 
         We need to be aware that in case of relations this function is not only called for the record results
         but also called once for every relation
         
         The difference is that a normal result is an object { recordResult: [records]}
         and the relations are returned as a { relationSet: { }}
         
         */
         if(data.recordResult){
            // store the records and the queryinfo in the clients session (if the conditions are not there, the session function 
            // will automatically convert it into a bucket only query)
            me.sessionModule.storeRecords(client.user,client.sessionKey,data.recordResult);
            me.sessionModule.storeQuery(client.user,client.sessionKey,fetchinfo.bucket,fetchinfo.conditions,fetchinfo.parameters);
            // send off the data
            callback({ 
               fetchResult: { 
                  bucket: fetchinfo.bucket, 
                  records: data.recordResult, 
                  returnData: fetchinfo.returnData
               }
            });            
         }
         if(data.relationSet){
            callback({
               fetchResult: {
                  relationSet: [ data.relationSet ],
                  returnData: fetchinfo.returnData
               }
            });
         }
      });
   },
   
   onRefresh: function(message,client,callback){
      // the onRefresh function is called to do the back end call and return the
      // data. As there is probably no change in data, we don't have to let
      // other clients know. For consistency, let's store the record in the session
      // information anyway to update the timestamp, maybe it can have some nice 
      // purpose in the future
      sys.puts("OrionServer onRefresh called");
      var refreshRec = message.refreshRecord;
      var storeRequest = { 
         bucket: refreshRec.bucket, 
         key: refreshRec.key,
         relations: refreshRec.relations
      };
      
      var me = this;
      var clientId = [client.user,client.sessionKey].join("_");
      if(refreshRec.bucket && refreshRec.key){
         this.store.refreshRecord(storeRequest,clientId,function(val){ 
            // this function can be called with different results: with record data and with relations
            var ret;
            if(val.refreshResult){
               var rec = val.refreshResult;
               ret = { refreshRecordResult: { bucket: rec.bucket, key: rec.key, record: rec, returnData: refreshRec.returnData } };
            }
            if(val.relationSet){
               ret = { refreshRecordResult: { relationSet: val.relationSet, returnData: refreshRec.returnData }};
            }
            callback(ret);
         });
      }
      else {
        sys.puts("OrionServer received an invalid refreshRecord call:");
        sys.puts("The offending message is: " + JSON.stringify(message)); 
      } 
   },
   
   distributeChanges: function(record,action,originalUser,originalSessionKey){
      // function to actually distribute a change in the database.
      // the record contains the new data, the action contains the original action by the client
      // the actions are "create","update","delete"... Depending on what the session cache tells us
      // ("bucketkey" or "query") and the action, server side requests will be made to the client.
      // the server doesn't expect any confirmation back! 
      // the function will not distribute the changes to the originalUser/sessionKeyCombination

      //sys.puts(" matching User sessions: " + sys.inspect(matchingUserSessions));
      
      /* 
      lets make a scheme of what action and what match type what server side request should be
      
      create:
         - bucketkey: highly unlikely and rather problematic... in this case the server should generate a warning...
                      The only case I can think of this happening is the delete action of a client results in 
                      a newly creation of the same record by another client... it still stinks...
         - query: this is very likely. in this case the server should send a createRecord message to the client
                  and update the sessionData of the client
         
      update: 
         - bucketkey: highly likely, in this case the server should send an updateRecord message to the client
         - query: rather peculiar, but might be possible... in this case send a createRecord message to the client,
                  if a record like this already exists on the client, it should consider it an update...
                  the use case here actually is less peculiar than originally thought:
                  it could be that some property has changed (or even permissions?)
                  which makes it match an existing query
                  
      delete:
         - bucketkey: likely, in this case the server should send a deleteRecord message to the client
         - query: rather peculiar... in this case the server shouldn't do anything, because the record doesn't exist at the 
                  client anyway
                  
      
      When the request is queued, we don't need to do anything else...
      as soon as the connection is restored, all actions will be sent to the client and the sessionCache updated.
      */      
      var matchingUserSessions = this.sessionModule.getMatchingUserSessionsForRecord(record);
      //sys.puts("Found " + matchingUserSessions.length + " matching user session for record " + JSON.stringify(record) + " and action " + action);
      var curUser, curSessionKey, curMatchType, result, createRequest;
      var me=this; // needed because everything below is inside a forEach
      matchingUserSessions.forEach(function(sessionInfo){
         curUser = sessionInfo.user;
         curSessionKey = sessionInfo.sessionKey;
         curMatchType = sessionInfo.matchType;
         //sys.puts("Current user: " + curUser);
         //sys.puts("current sessionKey: " + curSessionKey);
         //sys.puts("Current matchtype: " + curMatchType);
         if(curSessionKey !== originalSessionKey){
            switch(action){
               case 'create': 
                  if(curMatchType == 'bucketkey'){
                     // whoops??, just create a server side error message for now
                     sys.puts("The combination of a newly created record that matches a bucket/key combination for a different user hasn't been implemented yet.");
                  }
                  if(curMatchType == 'query'){
                     // send a createRecord request to the client and update the clients sessions
                     createRequest =  {createRecord: { bucket: record.bucket, key: record.key, record: record}};
                     result = me.socketIO.updateAuthenticatedClient(curUser,curSessionKey,createRequest);
                     if(result){
                        // update clients session
                        me.sessionModule.storeBucketKey(curUser,curSessionKey,record.bucket,record.key);
                     }
                     else {
                        // not sent to the client, push it to the request Queue
                        me.sessionModule.queueRequest(curUser,curSessionKey,createRequest);
                     }
                  }
                  break;
               case 'update':
                  if(curMatchType == 'bucketkey'){
                     //sys.puts("trying to send an update to user " + curUser + " with sessionKey " + curSessionKey);
                     // send an updateRecord request to the client and update the clients session
                     var updateRequest = { updateRecord: { bucket: record.bucket, key: record.key, record: record}};
                     result = me.socketIO.updateAuthenticatedClient(curUser,curSessionKey,updateRequest);
                     if(result){
                        me.sessionModule.queueRequest(curUser,curSessionKey,record.bucket,record.key);
                     }
                     else {
                        me.sessionModule.queueRequest(curUser,curSessionKey,updateRequest);
                     }
                  }
                  if(curMatchType == 'query'){
                     // send a createRecord request to the client and update the clients session
                     createRequest =  {createRecord: { bucket: record.bucket, key: record.key, record: record}};
                     result = me.socketIO.updateAuthenticatedClient(curUser,curSessionKey,createRequest);
                     if(result){
                        // update clients session
                        me.sessionModule.storeBucketKey(curUser,curSessionKey,record.bucket,record.key);
                     }
                     else {
                        // not sent to the client, push it to the request Queue
                        me.sessionModule.queueRequest(curUser,curSessionKey,createRequest);
                     }
                  }
                  break;
               case 'delete':
                  if(curMatchType == 'bucketkey'){
                     // send a delete request to the client and update the clients session
                     var deleteRequest = { deleteRecord: { bucket: record.bucket, key: record.key, record: record}};
                     result = me.socketIO.updateAuthenticatedClient(curUser,curSessionKey,deleteRequest);
                     if(result){
                        // update clients session
                        me.sessionModule.deleteBucketKey(curUser,curSessionKey,record.bucket,record.key);
                     }
                     else {
                        // not sent to the client, push it to the request Queue
                        me.sessionModule.queueRequest(curUser,curSessionKey,createRequest);
                     }                  
                  }
                  if(curMatchType == 'query'){
                     // do nothing
                  }
                  break;
               default: // whoops?? 
                  break;
            }                     
         }    
      });   // end forEach matchingSessions
   },
   
   // as a side note: I started first with the REST interface, so that is not part of the Listeners
   // and in essence it seems not to be necessary if the socketIO listener also can do the other types of 
   // client as is the concept of socket-io...
   // so there should be only one listener...
   
   onCreate: function(message,client,callback){
      var createRec = message.createRecord;
      var storeRequest = { 
         bucket: createRec.bucket, 
         key: createRec.key,
         recordData: createRec.record,
         relations: createRec.relations
      };
      var clientId = [client.user,client.sessionKey].join("_");
      var me = this;
      if(storeRequest.bucket && clientId){
         this.store.createRecord(storeRequest,clientId,
            function(val){
               // first update the original client and then update the others
               callback({createRecordResult: {record: val, returnData: createRec.returnData}});
               me.distributeChanges(val,"create",client.user,client.sessionKey);
            }
         );
      }
   },
   
   onUpdate: function(message,client,callback){
     var updateRec = message.updateRecord;
     var storeRequest = { 
        bucket: updateRec.bucket, 
        key: updateRec.key,
        recordData: updateRec.record,
        relations: updateRec.relations
     };
     var clientId = [client.user,client.sessionKey].join("_");
     var me = this;
     if(storeRequest.bucket && storeRequest.key && clientId){
        this.store.updateRecord(storeRequest,clientId,
           function(record){
              callback({updateRecordResult: {record: record, returnData: updateRec.returnData}}); // don't send the relationSet to the client
              me.distributeChanges(record,"update",client.user,client.sessionKey);
           }
        );
     }
   },
   
   onDelete: function(message,client,callback){
      var deleteRec = message.deleteRecord;
      var bucket = deleteRec.bucket;
      var key = deleteRec.key;
      var record = deleteRec.record; // this must be here, as we need the record data to distribute...
      // assign the bucket and key of the request to the record if they don't exist already... 
      // we need the bucket and key on the record in order to be able to distribute 
      if(!record.bucket && bucket) record.bucket = bucket; 
      if(!record.key && key) record.key = key;
      // sending the bucket and key around is sufficient, and probably we didn't get more data anyway...
      var clientId = [client.user,client.sessionKey].join("_");
      var me = this;
      if(bucket && key && clientId && record){ 
         var storeRequest = { 
            bucket: bucket, 
            key: key,
            recordData: record,
            relations: deleteRec.relations
         };
         this.store.deleteRecord(storeRequest, clientId, function(val){
            callback({deleteRecordResult: { bucket: bucket, key: key, record: record, returnData: deleteRec.returnData}});
            me.distributeChanges(record,"delete",client.user,client.sessionKey);
         });
      }
      else {
         sys.puts("Trying to destroy record without providing the proper record data!");
      }
   }
   
   
   
});



