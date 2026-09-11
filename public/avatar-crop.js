(function(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;else root.MiltonAvatarCrop=api})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";
  function layout(imageWidth,imageHeight,zoom=1,offsetX=0,offsetY=0,size=512){
    const scale=Math.max(size/imageWidth,size/imageHeight)*Math.max(1,Number(zoom)||1),width=imageWidth*scale,height=imageHeight*scale;
    const limitX=Math.max(0,(width-size)/2),limitY=Math.max(0,(height-size)/2);
    return{scale,width,height,x:(size-width)/2+Math.max(-limitX,Math.min(limitX,offsetX)),y:(size-height)/2+Math.max(-limitY,Math.min(limitY,offsetY)),offsetX:Math.max(-limitX,Math.min(limitX,offsetX)),offsetY:Math.max(-limitY,Math.min(limitY,offsetY))};
  }
  return{layout};
});
